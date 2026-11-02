import asyncio
import time
from collections import Counter
from collections.abc import Callable, Hashable, Iterator
from contextlib import contextmanager
from pathlib import Path
from typing import Any

from immich_ml import allocator
from immich_ml.config import log
from immich_ml.models.base import InferenceEntry, InferenceModel
from immich_ml.resources import Memory, read_resources
from immich_ml.schemas import Options

Key = tuple[type[InferenceModel[Any]], str, Hashable]

MiB = 1024 * 1024
# What a model takes is not known before it is loaded: its files twice (its weights mapped, and the arena of the
# runtime), at least this much. Measured with the default models: CLIP 350 MB of files and 16 MB more, faces 170 MB
# and 127 MB, text recognition 50 MB and 260 MB
MIN_MODEL_BYTES = 300 * MiB
# The memory left free besides what a model to load takes: a tenth of all, at most this much
MAX_RESERVE_BYTES = 256 * MiB
# Models evicted for memory are counted over this long, for the server to run one task at a time (see `/resources`)
EVICTION_WINDOW_S = 60


def _files_bytes(path: Path) -> int:
    try:
        return sum(file.stat().st_size for file in path.rglob("*") if file.is_file())
    except OSError:
        return 0


class ModelCache:
    """
    The models loaded, each kept until unused for its ttl. Before a model is loaded, models unused at the moment are
    unloaded, the least recently used first, while the memory left (of the container, else of the machine) is less
    than the model is estimated to take: a machine of much memory keeps all of them, one of little memory one at a
    time.
    """

    def __init__(self, read_memory: Callable[[], Memory | None] = lambda: read_resources()["memory"]) -> None:
        self._models: dict[Key, InferenceModel[Any]] = {}
        self._expiries: dict[Key, asyncio.TimerHandle] = {}
        self._used_at: dict[Key, float] = {}
        self._in_use: Counter[Key] = Counter()
        self._evictions: list[float] = []
        self._read_memory = read_memory

    @staticmethod
    def key[O: Options](entry: InferenceEntry[O]) -> Key:
        return (entry.model, entry.name, entry.model.graph(entry.options))

    def get[O: Options](self, entry: InferenceEntry[O], ttl: int | None = None) -> InferenceModel[O]:
        key = self.key(entry)
        if key not in self._models:
            self._models[key] = entry.model.create(entry.name, entry.options)
        elif key not in self._expiries:
            ttl = None  # a model that was preloaded stays
        if ttl:
            if key in self._expiries:
                self._expiries[key].cancel()
            self._expiries[key] = asyncio.get_running_loop().call_later(ttl, self._evict, key)
        self._used_at[key] = time.monotonic()
        return self._models[key]

    @contextmanager
    def using[O: Options](self, entry: InferenceEntry[O]) -> Iterator[None]:
        """While a model runs, it is not unloaded for another"""
        key = self.key(entry)
        self._in_use[key] += 1
        try:
            yield
        finally:
            self._in_use[key] -= 1
            self._used_at[key] = time.monotonic()

    def make_room[O: Options](self, entry: InferenceEntry[O]) -> None:
        """Unloads models unused at the moment, the least recently used first, until the model of `entry` fits"""
        key = self.key(entry)
        model = self._models.get(key)
        if model is None or model.loaded:
            return
        needed = max(2 * _files_bytes(model.cache_dir), MIN_MODEL_BYTES)
        while (memory := self._read_memory()) is not None:
            reserve = min(memory["limit"] // 10, MAX_RESERVE_BYTES)
            if memory["limit"] - memory["used"] >= needed + reserve:
                return
            idle = [k for k, m in self._models.items() if k != key and m.loaded and not self._in_use[k]]
            if not idle:
                return
            victim = min(idle, key=lambda k: self._used_at.get(k, 0))
            log.info(
                f"Unloading model '{victim[1]}' to load '{entry.name}': "
                f"{(memory['limit'] - memory['used']) // MiB} MiB left of {memory['limit'] // MiB}"
            )
            self._unload(victim)
            self._evictions.append(time.monotonic())

    def recent_evictions(self) -> int:
        """The models unloaded for others in the last minute"""
        since = time.monotonic() - EVICTION_WINDOW_S
        self._evictions = [at for at in self._evictions if at >= since]
        return len(self._evictions)

    def clear(self) -> None:
        if not self._models:
            return
        self._models.clear()
        for key in list(self._expiries.keys()):
            self._expiries.pop(key).cancel()
        allocator.release()

    def _unload(self, key: Key) -> None:
        self._models[key].unload()
        allocator.release()

    def _evict(self, key: Key) -> None:
        if key not in self._models:
            return
        del self._models[key], self._expiries[key]
        self._used_at.pop(key, None)
        allocator.release()
