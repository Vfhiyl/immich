"""What the results of a model depend on: the files of its export, hashed.

The server keeps, for every result, the fingerprint of the model that made it, and makes the results again when the
files of a model change (e.g. downloaded again after the cache was lost, from a repository whose files were replaced).
Only the export of the repository counts: the conversions for hardware acceleration (which upstream documents as
needing no new results) and the graphs this service prepares for an execution provider (in subfolders) do not.
"""

import hashlib
from collections.abc import Iterable
from fnmatch import fnmatch
from pathlib import Path
from threading import Lock

CONVERSIONS = ("*.armnn", "*.rknn")

_digests: dict[Path, tuple[tuple[int, int, int], str]] = {}
_lock = Lock()


def file_digest(path: Path) -> str:
    """The SHA-256 of a file, read again only when its size, modification time or inode changed."""
    stat = path.stat()
    key = (stat.st_size, stat.st_mtime_ns, stat.st_ino)
    with _lock:
        known = _digests.get(path)
    if known is not None and known[0] == key:
        return known[1]
    with path.open("rb") as file:
        digest = hashlib.file_digest(file, "sha256").hexdigest()
    with _lock:
        _digests[path] = (key, digest)
    return digest


def export_files(cache_dir: Path, model_dirs: Iterable[Path]) -> list[Path]:
    """The files of the export in `model_dirs` (their first level), with the configuration all models of a repository
    share, in a fixed order."""
    candidates = [
        cache_dir / "config.json",
        *(path for folder in model_dirs if folder.is_dir() for path in folder.iterdir()),
    ]
    files = [
        path
        for path in candidates
        if path.is_file()
        and not path.name.startswith(".")
        and not any(fnmatch(path.name, pattern) for pattern in CONVERSIONS)
    ]
    return sorted(files, key=lambda path: path.relative_to(cache_dir).as_posix())


def fingerprint(cache_dir: Path, model_dirs: Iterable[Path]) -> str:
    digest = hashlib.sha256()
    for path in export_files(cache_dir, model_dirs):
        digest.update(f"{path.relative_to(cache_dir).as_posix()}\0{file_digest(path)}\n".encode())
    return digest.hexdigest()
