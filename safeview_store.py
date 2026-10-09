"""Safe View's prompt-metadata cache — the opt-in fourth haystack.

**Canonical home — edit it HERE.** Like ``image_meta.py`` (which it calls), this
module lives in comfyui-image-browser and is vendored downstream into
comfyui-gallery-loader, the reverse direction from ``xmp_meta.py`` /
``thumb_cache.py`` / ``pins_store.py``. It has to live wherever ``image_meta``
lives, because it is a thin cache in front of it.

WHY A CACHE AT ALL. Safe View's free tiers match a keyword list against a file's
name, the folders above it and its XMP tags — all of which ``/list`` already
knows. This tier adds the file's embedded GENERATION PROMPT and model name,
which ``/list`` does not know and cannot cheaply learn: ``image_meta`` opens the
file and walks its containers, and doing that per file per listing would put a
multi-megabyte parse on the event loop for every card in the grid. So the
extracted text is cached on disk, keyed so that editing a file invalidates it.

THE CACHE HOLDS TEXT, NOT A VERDICT. Two consequences, both deliberate:

  * Changing the keyword list needs NO re-scan. A cached verdict would be keyed
    on (file, keywords) and every keyword edit would invalidate the whole
    library — on a tier whose whole problem is that scanning is expensive.
  * The matching itself stays in ``image_browser.py``, next to the free tiers,
    using the same ``safe_tokenize`` / ``is_safe_match`` the name and path
    haystacks go through. One matcher, one set of semantics, one place to keep
    in step with the frontend kit.

The response therefore carries ONE BOOLEAN per file, never the prompt text: the
text is what the user asked not to have on screen, and shipping it to the
browser so the browser could match it would defeat the point.

DISCRETION, NOT ACCESS CONTROL — the same caveat as the rest of Safe View. This
module reads files the caller could already read through ``/metadata``; it
hides nothing from anyone and authenticates no one.

Pure stdlib (``sqlite3`` ships with CPython) plus this pack's ``image_meta``.
No new Python dependency, per CLAUDE.md.
"""

from __future__ import annotations

import asyncio
import contextlib
import hashlib
import logging
import os
import sqlite3
import time
from typing import TYPE_CHECKING

if TYPE_CHECKING:  # pragma: no cover - typing only
    from collections.abc import Iterable, Sequence

try:
    # ComfyUI imports custom_nodes as packages; the sibling module must be
    # pulled in relatively. Same dance as image_browser.py.
    from . import image_meta
except ImportError:
    # Pytest imports this module flat (pack root on sys.path).
    import image_meta

log = logging.getLogger("comfyui-safeview-store")

# Single shared file under ComfyUI's user dir — joined against
# folder_paths.get_user_directory() by the caller, exactly as
# thumb_cache.CACHE_DIR_NAME and pins_store.PINS_FILE_NAME are, which is what
# makes one scan serve both gallery packs.
DB_FILE_NAME = "comfy-safeview.sqlite"

# Cap on the text stored per file. The prompt is matched as whole tokens, so a
# truncated tail costs at most a keyword that appears nowhere in the first 2 KB
# of a prompt — while an uncapped store would happily persist the megabyte-scale
# values image_meta is itself capped against.
MAX_TEXT_BYTES = 2048

# Summary keys whose values form the haystack. Deliberately NOT the whole raw
# metadata blob: that carries node class names, filename prefixes and every
# widget value in the graph, so a keyword like `flux` or `output` would match
# essentially every file. Prompt text and model name are what a user means by
# "match the generation prompt".
TEXT_KEYS = ("positive", "negative", "model")

# Best-effort size cap on the cache. At ~1 KB of text per row this bounds the
# file to roughly 200 MB before pruning kicks in.
MAX_ENTRIES = 200_000

# SQLite's default host-parameter limit is 999 on older builds; chunk well under
# it so a listing of thousands of files still reads in a handful of queries.
_SELECT_CHUNK = 400

# Backstop on the background sweep's enumeration, mirroring image_browser's
# FLAT_WALK_CAP: a pathological tree must not make one sweep unbounded. A sweep
# that hits it simply covers less; the next one starts over and the files it did
# cache are already cached.
SWEEP_WALK_CAP = 200_000

# Files handed to one executor call. Small enough that the event loop gets a
# turn between batches (a 4000-file first sweep otherwise blocks a worker for
# minutes with no chance to cancel), large enough that the per-call overhead and
# the two sqlite connections per batch stay amortised.
SWEEP_BATCH = 32

_SCHEMA = """
CREATE TABLE IF NOT EXISTS prompt_text (
    key TEXT PRIMARY KEY,
    text TEXT NOT NULL,
    stored_at REAL NOT NULL
)
"""


def cache_key(path: str, st: os.stat_result) -> str:
    """Stable key for one file: fully determined by path + mtime + size.

    Byte-identical in SHAPE to ``thumb_cache.cache_key`` on purpose — the same
    invalidation semantics (an edited file keys a fresh entry, a moved file
    keys a fresh entry) with no second scheme to reason about. The two caches
    live in different stores, so the shared shape costs nothing and buys one
    mental model.
    """
    return hashlib.sha1(f"{path}:{st.st_mtime_ns}:{st.st_size}".encode()).hexdigest()


def db_path(user_dir: str) -> str:
    """The cache file inside ComfyUI's user directory."""
    return os.path.join(user_dir, DB_FILE_NAME)


def extract_text(path: str) -> str:
    """Read ``path``'s embedded prompt + model into one matchable string.

    Never raises: ``image_meta`` is written against attacker-shaped input and
    returns empty rather than throwing, and anything it does let through is
    swallowed here. A file that yields nothing is still CACHED (as an empty
    string) — "scanned, carries no prompt" and "not scanned yet" are different
    facts, and conflating them would re-scan every screenshot forever.
    """
    try:
        raw, _truncated = image_meta.read_raw_metadata(path)
        _source, summary = image_meta.parse_generation_meta(raw)
    except Exception as exc:  # pragma: no cover - image_meta is itself guarded
        log.warning("safe-view metadata read failed for %s: %s", path, exc)
        return ""
    parts = [summary.get(k, "") for k in TEXT_KEYS]
    return " ".join(p for p in parts if p)[:MAX_TEXT_BYTES]


@contextlib.contextmanager
def _connect(path: str, *, create: bool = False):
    """Open the cache database, yielding None on any failure.

    Every caller must tolerate a ``None`` connection: a cache is an
    optimisation, and a listing must still answer when the disk is full, the
    user dir is read-only, or the file is corrupt.

    ``create`` is False on the READ path, deliberately. A read must have no
    side effects: with it on, a listing against a mis-resolved user directory
    silently mkdir's that path — observed creating a literal
    ``<MagicMock ...>/`` directory in the repo root during a mutation run,
    which is the same shape a real ``folder_paths`` misconfiguration would take
    on someone's disk.
    """
    conn: sqlite3.Connection | None = None
    try:
        parent = os.path.dirname(path)
        if create and parent:
            os.makedirs(parent, exist_ok=True)
        if not create and not os.path.exists(path):
            # Nothing cached yet — every key reads as "unscanned", which is the
            # correct cold-cache answer and costs no file system mutation.
            yield None
            return
        conn = sqlite3.connect(path, timeout=5.0)
        conn.execute(_SCHEMA)
    except Exception as exc:
        log.warning("safe-view cache unavailable at %s: %s", path, exc)
        if conn is not None:
            with contextlib.suppress(Exception):
                conn.close()
        yield None
        return
    try:
        yield conn
    finally:
        with contextlib.suppress(Exception):
            conn.close()


def read_cached(path: str, keys: Sequence[str]) -> dict[str, str]:
    """Cached text for each of ``keys`` that has one. Missing keys are absent.

    ONE batched query per listing, not one per file — a listing of 5000 cards
    otherwise pays 5000 round trips on the event loop. An absent key is the
    "unscanned" state the caller turns into the frontend's sentinel; it must
    never be conflated with a present-but-empty entry (see :func:`extract_text`).
    """
    if not keys:
        return {}
    out: dict[str, str] = {}
    with _connect(path) as conn:
        if conn is None:
            return {}
        try:
            for start in range(0, len(keys), _SELECT_CHUNK):
                chunk = keys[start : start + _SELECT_CHUNK]
                # The only interpolated part is a run of `?` placeholders whose
                # length is len(chunk); every key travels as a bound parameter.
                marks = ",".join("?" * len(chunk))
                rows = conn.execute(
                    f"SELECT key, text FROM prompt_text WHERE key IN ({marks})",
                    tuple(chunk),
                )
                for key, text in rows:
                    out[key] = text
        except Exception as exc:
            log.warning("safe-view cache read failed: %s", exc)
            return out
    return out


def store_texts(path: str, rows: Iterable[tuple[str, str]]) -> int:
    """Write ``(key, text)`` pairs. Returns how many were stored (0 on failure)."""
    items = list(rows)
    if not items:
        return 0
    now = time.time()
    with _connect(path, create=True) as conn:
        if conn is None:
            return 0
        try:
            conn.executemany(
                "INSERT OR REPLACE INTO prompt_text (key, text, stored_at) VALUES (?, ?, ?)",
                [(k, t, now) for k, t in items],
            )
            conn.commit()
            _prune(conn)
        except Exception as exc:
            log.warning("safe-view cache write failed: %s", exc)
            return 0
    return len(items)


def _prune(conn: sqlite3.Connection, max_entries: int = MAX_ENTRIES) -> None:
    """Best-effort: drop the oldest rows beyond ``max_entries``."""
    try:
        (count,) = conn.execute("SELECT COUNT(*) FROM prompt_text").fetchone()
        if count <= max_entries:
            return
        conn.execute(
            "DELETE FROM prompt_text WHERE key IN ("
            "  SELECT key FROM prompt_text ORDER BY stored_at ASC LIMIT ?"
            ")",
            (count - max_entries,),
        )
        conn.commit()
    except Exception as exc:  # pragma: no cover - best effort
        log.warning("safe-view cache prune failed: %s", exc)


def scan_paths(path: str, targets: Sequence[str]) -> int:
    """Parse and cache every uncached file in ``targets``. Returns how many.

    BLOCKING — ``image_meta`` opens files and walks containers, which is exactly
    the work that must not run on the event loop. Callers hand this to
    ``loop.run_in_executor``.

    Files that vanish between the walk and the parse are skipped silently: a
    sweep racing a delete is normal, not an error.
    """
    pending: list[tuple[str, str]] = []
    keyed: list[tuple[str, str]] = []
    for target in targets:
        try:
            st = os.stat(target)
        except OSError:
            continue
        keyed.append((cache_key(target, st), target))
    if not keyed:
        return 0
    have = read_cached(path, [k for k, _ in keyed])
    for key, target in keyed:
        if key in have:
            continue
        pending.append((key, extract_text(target)))
    return store_texts(path, pending)


# ---------------------------------------------------------------------------
# The background sweep
# ---------------------------------------------------------------------------
#
# The cache has two warmers, and BOTH are needed:
#
#   * this sweep, which covers the BACKLOG — everything already on disk when
#     the user first switches the tier on;
#   * the frontend's `executed` websocket listener, which covers FRESH RENDERS
#     the instant they land, but only while a browser tab is open.
#
# Neither subsumes the other: the sweep cannot see a render that happens after
# it finishes, and the listener cannot see a library that predates it.


def walk_candidates(
    roots: Iterable[str],
    exts: set[str],
    cap: int = SWEEP_WALK_CAP,
) -> list[str]:
    """Every file under ``roots`` whose extension is in ``exts``, capped.

    Same walk discipline as the flat lister in ``image_browser.py``: DFS over
    ``os.scandir`` with ``follow_symlinks=False`` throughout (so the sweep can
    never be walked out of the root by a link), hidden entries skipped, and the
    ``clipspace`` / ``__pycache__`` directories skipped.
    """
    out: list[str] = []
    stack: list[str] = [r for r in roots if r]
    while stack:
        directory = stack.pop()
        try:
            with os.scandir(directory) as it:
                for entry in it:
                    try:
                        if entry.name.startswith("."):
                            continue
                        if entry.is_dir(follow_symlinks=False):
                            if entry.name in ("clipspace", "__pycache__"):
                                continue
                            stack.append(entry.path)
                        elif entry.is_file(follow_symlinks=False):
                            if os.path.splitext(entry.name)[1].lower() in exts:
                                out.append(entry.path)
                                if len(out) >= cap:
                                    return out
                    except OSError:
                        continue
        except OSError:
            # An unreadable subdirectory is skipped, never fatal — a warmer
            # should cache everything it can reach.
            continue
    return out


async def sweep(path: str, roots: Iterable[str], exts: set[str]) -> int:
    """Cache the prompt text of every uncached file under ``roots``.

    Returns how many files were newly scanned.

    EVERY blocking step runs in an executor — the enumeration walk as well as
    the parses. ``image_meta`` on the event loop is precisely the stall this
    exists to avoid, and a 200k-entry ``scandir`` walk is not free either.
    Between batches the coroutine yields, so cancelling the sweep (a shutdown,
    a superseding sweep) takes effect within one batch rather than at the end.
    """
    loop = asyncio.get_running_loop()
    targets = await loop.run_in_executor(None, walk_candidates, roots, exts)
    scanned = 0
    for start in range(0, len(targets), SWEEP_BATCH):
        batch = targets[start : start + SWEEP_BATCH]
        scanned += await loop.run_in_executor(None, scan_paths, path, batch)
        # Give the loop a turn even when the executor returned instantly (an
        # all-cached batch), so a long sweep over a warm cache still cancels.
        await asyncio.sleep(0)
    return scanned
