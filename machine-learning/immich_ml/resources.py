"""How much memory this service has and uses, for the server to slow down its jobs before the memory runs out.

The memory of the container when it has a limit (cgroup v2, else v1), else of the machine; in use means without the
page cache the kernel gives back when it needs to (as `docker stats` counts it). Pressure is the share of time tasks
waited for memory over the last 10 seconds (PSI), of the container or else the machine, when the kernel tells it.
"""

from pathlib import Path

from typing_extensions import TypedDict

# cgroup v1 reports "no limit" as the largest multiple of the page size
_UNLIMITED = 1 << 60


class Memory(TypedDict):
    used: int
    limit: int
    source: str  # cgroup2, cgroup1 or meminfo


class Pressure(TypedDict):
    some: float
    full: float


class Resources(TypedDict):
    memory: Memory | None
    pressure: Pressure | None


def _read(path: Path) -> str | None:
    try:
        return path.read_text()
    except OSError:
        return None


def _stat(text: str | None) -> dict[str, int]:
    values: dict[str, int] = {}
    for line in (text or "").splitlines():
        key, _, value = line.partition(" ")
        if value.strip().isdigit():
            values[key] = int(value)
    return values


def _cgroup2(root: Path) -> Memory | None:
    folder = root / "sys/fs/cgroup"
    limit, current = _read(folder / "memory.max"), _read(folder / "memory.current")
    if limit is None or current is None or limit.strip() == "max":
        return None
    cache = _stat(_read(folder / "memory.stat")).get("inactive_file", 0)
    return {"used": max(int(current) - cache, 0), "limit": int(limit), "source": "cgroup2"}


def _cgroup1(root: Path) -> Memory | None:
    folder = root / "sys/fs/cgroup/memory"
    limit, usage = _read(folder / "memory.limit_in_bytes"), _read(folder / "memory.usage_in_bytes")
    if limit is None or usage is None or int(limit) >= _UNLIMITED:
        return None
    cache = _stat(_read(folder / "memory.stat")).get("total_inactive_file", 0)
    return {"used": max(int(usage) - cache, 0), "limit": int(limit), "source": "cgroup1"}


def _meminfo(root: Path) -> Memory | None:
    values: dict[str, int] = {}
    for line in (_read(root / "proc/meminfo") or "").splitlines():
        key, _, value = line.partition(":")
        if value.strip().endswith("kB"):
            values[key] = int(value.split()[0]) * 1024
    if "MemTotal" not in values or "MemAvailable" not in values:
        return None
    return {"used": values["MemTotal"] - values["MemAvailable"], "limit": values["MemTotal"], "source": "meminfo"}


def _pressure(root: Path) -> Pressure | None:
    for path in (root / "sys/fs/cgroup/memory.pressure", root / "proc/pressure/memory"):
        text = _read(path)
        if not text:
            continue
        found: dict[str, float] = {}
        for line in text.splitlines():
            kind, *fields = line.split()
            averages = dict(field.split("=", 1) for field in fields if "=" in field)
            if "avg10" in averages:
                found[kind] = float(averages["avg10"])
        if "some" in found:
            return {"some": found["some"], "full": found.get("full", 0.0)}
    return None


def read_resources(root: Path = Path("/")) -> Resources:
    return {
        "memory": _cgroup2(root) or _cgroup1(root) or _meminfo(root),
        "pressure": _pressure(root),
    }
