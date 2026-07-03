"""Shared on-disk thumbnail cache for the laurigates ComfyUI packs.

Canonical home: comfyui-gallery-loader/thumb_cache.py. Vendored verbatim into
comfyui-image-browser (``just sync-thumb-cache`` there) — do not edit the
vendored copy; land changes here first.

Both packs resolve the SAME cache directory (``<user_dir>/comfy-thumb-cache``)
and the SAME key — sha1 of ``path:mtime_ns:size`` — so a thumbnail encoded for
one pack is served from cache by the other, and editing a file (new mtime)
simply keys a fresh entry. Cache entries are complete 512px WebP files written
atomically (temp file + ``os.replace``), so concurrent readers/writers from
both packs' handlers can never observe a torn entry.

Uses ComfyUI-bundled libraries ONLY (PIL) plus the Python stdlib.
"""

from __future__ import annotations

import contextlib
import hashlib
import logging
import os
import tempfile
from io import BytesIO

from PIL import Image

log = logging.getLogger("comfy-thumb-cache")

THUMB_SIZE = (512, 512)
WEBP_QUALITY = 80

# Single shared directory name under ComfyUI's user dir — both packs join
# this against folder_paths.get_user_directory(), which is what makes the
# cache shared.
CACHE_DIR_NAME = "comfy-thumb-cache"

# Best-effort size cap: every _PRUNE_EVERY stores, drop the oldest entries
# beyond MAX_ENTRIES. At ~30 KB per 512px WebP that bounds the cache to
# roughly 300 MB.
MAX_ENTRIES = 10_000
_PRUNE_EVERY = 512
_stores_since_prune = 0


def cache_key(path: str, st: os.stat_result) -> str:
    """Stable key for a source image: fully determined by path + mtime + size."""
    return hashlib.sha1(f"{path}:{st.st_mtime_ns}:{st.st_size}".encode()).hexdigest()


def etag_for(path: str, st: os.stat_result) -> str:
    """The HTTP ETag both packs' /thumb endpoints send (quoted cache key)."""
    return f'"{cache_key(path, st)}"'


def encode_thumb(path: str) -> bytes | None:
    """Encode a capped 512px WebP thumbnail for an image file (no cache)."""
    try:
        with Image.open(path) as im:
            im.thumbnail(THUMB_SIZE)
            im = im.convert("RGB") if im.mode not in ("RGB", "RGBA") else im
            buf = BytesIO()
            im.save(buf, format="webp", quality=WEBP_QUALITY)
            return buf.getvalue()
    except Exception as exc:
        log.warning("thumb encode failed for %s: %s", path, exc)
        return None


def get_thumb(path: str, st: os.stat_result, cache_dir: str) -> bytes | None:
    """Return WebP thumb bytes for ``path``, via the shared disk cache.

    Cache hit reads the stored entry; miss encodes and stores it. Cache I/O
    failures degrade to encode-only — serving never breaks on cache trouble.
    """
    cpath = os.path.join(cache_dir, cache_key(path, st) + ".webp")
    try:
        with open(cpath, "rb") as f:
            return f.read()
    except OSError:
        pass
    data = encode_thumb(path)
    if data is not None:
        _store(cpath, data, cache_dir)
    return data


def _store(cpath: str, data: bytes, cache_dir: str) -> None:
    global _stores_since_prune
    try:
        os.makedirs(cache_dir, exist_ok=True)
        fd, tmp = tempfile.mkstemp(dir=cache_dir, suffix=".tmp")
        try:
            with os.fdopen(fd, "wb") as f:
                f.write(data)
            os.replace(tmp, cpath)
        except OSError:
            with contextlib.suppress(OSError):
                os.remove(tmp)
            raise
    except OSError as exc:
        log.warning("thumb cache write failed for %s: %s", cpath, exc)
        return
    _stores_since_prune += 1
    if _stores_since_prune >= _PRUNE_EVERY:
        _stores_since_prune = 0
        prune(cache_dir)


def prune(cache_dir: str, max_entries: int = MAX_ENTRIES) -> None:
    """Best-effort: delete the oldest entries beyond ``max_entries``."""
    entries: list[tuple[float, str]] = []
    try:
        with os.scandir(cache_dir) as it:
            for entry in it:
                try:
                    if entry.is_file(follow_symlinks=False):
                        entries.append((entry.stat(follow_symlinks=False).st_mtime, entry.path))
                except OSError:
                    continue
    except OSError:
        return
    if len(entries) <= max_entries:
        return
    entries.sort()
    for _, p in entries[: len(entries) - max_entries]:
        with contextlib.suppress(OSError):
            os.remove(p)
