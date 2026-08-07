"""Shared server-side pin store for the laurigates ComfyUI browser packs.

Canonical home: comfyui-gallery-loader/pins_store.py. Vendored verbatim into
comfyui-image-browser (``just sync-pins-store`` there) — do not edit the
vendored copy; land changes here first.

Both packs join ``PINS_FILE_NAME`` onto ComfyUI's user directory, so both
resolve the SAME file (``<user_dir>/comfy-pins.json``) and a pin set in one
pack is visible in the other — the same mechanism ``thumb_cache.CACHE_DIR_NAME``
uses to share encoded thumbnails. Because the file lives on the **server**, the
list is also shared between DEVICES: a phone and a desktop are two browsers
against one ComfyUI, and ``localStorage`` structurally cannot span them. That
is the whole reason this module exists rather than a browser-side list.

Why JSON and not SQLite: a pin list is a few hundred entries always read whole,
and a plain file is hand-fixable over ssh on a headless box. SQLite's main draw
here would have been surviving lost updates, and the delta API (``apply_delta``,
never a whole-list PUT) removes that risk on aiohttp's single-threaded event
loop — a read-modify-write inside one handler cannot interleave with another.

Why not XMP, where the ratings live: every XMP write REPLACES the file, giving
it a new mtime, which jumps it to the top of every newest-first listing and
invalidates its thumbnail cache entry (keyed on ``path:mtime_ns:size``). That is
an acceptable price for setting a rating once; it is the wrong price for a
toggle. XMP also has no index, so "list my pins" would mean walking the tree.

Uses the Python stdlib ONLY — no ComfyUI imports, no PIL — so every mutation
helper here is a pure function that unit-tests without a server or a disk.
"""

from __future__ import annotations

import contextlib
import json
import logging
import os
import tempfile
from collections.abc import Callable, Iterable
from typing import Any

log = logging.getLogger("comfyui-pins-store")

# Single shared filename under ComfyUI's user dir — both packs join this against
# folder_paths.get_user_directory(), which is what makes the store shared.
PINS_FILE_NAME = "comfy-pins.json"

# Bumped only for a shape change the readers below cannot absorb. Readers accept
# any version and tolerate unknown keys, so an older pack reading a newer file
# degrades to "ignores what it doesn't understand" rather than erroring.
PINS_VERSION = 1

# Ceiling on the stored list. A GET stats every pin to report `exists` (and the
# grid's file stats), so an unbounded list would ask the event loop to stat a
# whole tree on every open — the same discipline as image_browser's
# MAX_RATING_BATCH. The UI is expected to SAY it hit the cap rather than let an
# add silently do nothing, so `add_pin` reports the refusal instead of clamping.
MAX_PINS = 200

# A pin is either a folder (the pre-existing quick-nav affordance) or a single
# file (the point of the feature: six images in six directories, one list).
PIN_KINDS = ("dir", "file")

# Pins address sandboxed roots only, exactly like every write in both packs —
# `type=path` is rejected here as it is at the endpoints (ADR-0002). Kept as a
# literal rather than imported from either pack so this module stays free of
# ComfyUI imports and testable bare.
PIN_TYPES = ("input", "output", "temp")

# The keys `normalize_pin` owns. Anything else on an entry is preserved verbatim
# (see the docstring there) rather than dropped.
_KNOWN_KEYS = ("kind", "type", "subfolder", "name")


# ---------------------------------------------------------------------------
# Pure helpers — no disk, no ComfyUI
# ---------------------------------------------------------------------------


def _clean_subfolder(raw: Any) -> str | None:
    """Normalize a stored subfolder, or None when it is not addressable.

    Accepts ``""`` (a root) and forward-slashed relative paths. Backslashes are
    normalized to ``/`` so a Windows-authored entry keys the same as a
    POSIX-authored one. Rejects absolute paths and any ``..`` component: the
    endpoint resolvers reject those anyway, but a store that never holds one
    cannot hand a traversal string to a caller that forgets to re-check.
    """
    if raw is None:
        return ""
    if not isinstance(raw, str):
        return None
    parts = [p for p in raw.replace("\\", "/").split("/") if p not in ("", ".")]
    if any(p == ".." for p in parts):
        return None
    if raw.startswith("/"):
        return None
    return "/".join(parts)


def _is_bare_name(name: Any) -> bool:
    """True if ``name`` is a single path component with no traversal.

    Both packs' backends apply the same predicate to a mutation target;
    duplicated (not imported) to keep this module ComfyUI-free — and made one
    notch STRICTER on purpose. ``os.path.basename`` is platform-aware, so on
    POSIX it does not treat ``\\`` as a separator and ``a\\b.png`` passes it as
    "bare". That is survivable for a request resolved once, but this store is
    persisted and read by another OS's browser, where the same string is two
    path components. Rejecting both separators outright keeps one stored pin
    from meaning two different files.
    """
    return (
        isinstance(name, str)
        and bool(name)
        and "/" not in name
        and "\\" not in name
        and os.path.basename(name) == name
        and name not in (".", "..")
    )


def normalize_pin(raw: Any) -> dict[str, Any] | None:
    """Validate one pin entry, returning a normalized dict or None.

    None means "not addressable" — a bad kind/type, a traversing subfolder, a
    file pin without a bare filename. Callers DROP those (on read) or 400 on
    them (on write); they are never repaired into something adjacent, because a
    repaired address is a pin pointing at a file the user did not choose.

    Unknown keys are preserved verbatim so a field added by a newer pack
    survives a round-trip through an older one — the store is shared, and a
    reader that silently drops what it doesn't understand corrupts the writer's
    data on the next add.
    """
    if not isinstance(raw, dict):
        return None
    kind = raw.get("kind")
    if kind not in PIN_KINDS:
        return None
    type_name = raw.get("type")
    if type_name not in PIN_TYPES:
        return None
    subfolder = _clean_subfolder(raw.get("subfolder"))
    if subfolder is None:
        return None
    pin: dict[str, Any] = {"kind": kind, "type": type_name, "subfolder": subfolder}
    if kind == "file":
        name = raw.get("name")
        if not _is_bare_name(name):
            return None
        pin["name"] = name
    for key, value in raw.items():
        if key not in _KNOWN_KEYS:
            pin[key] = value
    return pin


def pin_key(pin: dict[str, Any]) -> tuple[str, str, str, str]:
    """Identity of a pin — what add/remove dedupe on.

    A folder pin and a file pin at the same address are DIFFERENT pins (the
    ``kind`` is part of the key), so pinning `output/keep` as a folder does not
    collide with a file called `keep` sitting beside it.
    """
    return (
        str(pin.get("kind", "")),
        str(pin.get("type", "")),
        str(pin.get("subfolder", "")),
        str(pin.get("name", "")),
    )


def add_pin(pins: Iterable[dict[str, Any]], item: Any) -> tuple[list[dict[str, Any]], str]:
    """Append ``item`` to ``pins``. Returns (new_list, error) — error '' on success.

    Adding an already-present pin is a NO-OP, not an error: the frontend's
    localStorage migration replays every old pin as an add, and a second run
    (or two devices migrating) must not fail. That also makes the whole delta
    API idempotent, which is what lets a retried request be safe.

    The cap is reported rather than applied silently — an add that vanishes
    reads as a broken button.
    """
    pin = normalize_pin(item)
    if pin is None:
        return list(pins), "invalid pin"
    out = list(pins)
    key = pin_key(pin)
    for existing in out:
        if pin_key(existing) == key:
            return out, ""
    if len(out) >= MAX_PINS:
        return out, f"pin limit reached (max {MAX_PINS})"
    out.append(pin)
    return out, ""


def remove_pin(pins: Iterable[dict[str, Any]], item: Any) -> tuple[list[dict[str, Any]], str]:
    """Drop ``item`` from ``pins``. Returns (new_list, error).

    Removing something absent is a no-op, for the same idempotence reason as
    ``add_pin`` — an unpin that raced a second unpin must not surface an error.
    """
    pin = normalize_pin(item)
    if pin is None:
        return list(pins), "invalid pin"
    key = pin_key(pin)
    return [p for p in pins if pin_key(p) != key], ""


def prune_missing(
    pins: Iterable[dict[str, Any]], exists: Callable[[dict[str, Any]], bool]
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """Split ``pins`` into (kept, dropped) by an ``exists`` predicate.

    The predicate is injected rather than resolved here so this stays pure and
    ComfyUI-free: the caller owns path resolution (and its sandbox perimeter).
    """
    kept: list[dict[str, Any]] = []
    dropped: list[dict[str, Any]] = []
    for pin in pins:
        (kept if exists(pin) else dropped).append(pin)
    return kept, dropped


def apply_delta(
    pins: Iterable[dict[str, Any]],
    op: Any,
    item: Any = None,
    exists: Callable[[dict[str, Any]], bool] | None = None,
) -> tuple[list[dict[str, Any]], str]:
    """Dispatch one delta operation. Returns (new_list, error).

    The endpoint takes a DELTA (``add`` / ``remove`` / ``prune``) and never a
    whole-list PUT: two browsers with the same page open would each send their
    own full list, and the second write would silently discard the first's pin.
    A delta applied inside one aiohttp handler cannot lose an update, which is
    the property SQLite would otherwise have been bought for.

    Both packs share this dispatcher so their two endpoints cannot drift into
    accepting different operation names for the same file.
    """
    if op == "add":
        return add_pin(pins, item)
    if op == "remove":
        return remove_pin(pins, item)
    if op == "prune":
        if exists is None:
            return list(pins), "prune needs an existence check"
        kept, _dropped = prune_missing(pins, exists)
        return kept, ""
    return list(pins), "op must be add, remove or prune"


# ---------------------------------------------------------------------------
# Disk I/O
# ---------------------------------------------------------------------------


def pins_path(user_dir: str) -> str:
    """The shared store's absolute path for a given ComfyUI user directory."""
    return os.path.join(str(user_dir), PINS_FILE_NAME)


def load_pins(path: str) -> list[dict[str, Any]]:
    """Read the pin list. NEVER raises — a bad file degrades to an empty list.

    A missing file is the normal first-run case and logs nothing. A corrupt or
    hand-mangled one logs a warning and reads as empty rather than 500ing every
    browser open: the store is a convenience index, and refusing to open the
    gallery because a JSON file lost a brace would be the worse failure. Entries
    that fail ``normalize_pin`` are dropped individually, so one bad row cannot
    take the rest of the list with it.
    """
    try:
        with open(path, encoding="utf-8") as f:
            data = json.load(f)
    except FileNotFoundError:
        return []
    except (OSError, ValueError) as exc:
        log.warning("pin store unreadable at %s (%s) — treating as empty", path, exc)
        return []
    if not isinstance(data, dict):
        log.warning("pin store at %s is not an object — treating as empty", path)
        return []
    raw_pins = data.get("pins")
    if not isinstance(raw_pins, list):
        return []
    out: list[dict[str, Any]] = []
    seen: set[tuple[str, str, str, str]] = set()
    for entry in raw_pins:
        pin = normalize_pin(entry)
        if pin is None:
            continue
        key = pin_key(pin)
        if key in seen:
            continue
        seen.add(key)
        out.append(pin)
    return out[:MAX_PINS]


def save_pins(path: str, pins: Iterable[dict[str, Any]]) -> None:
    """Write the pin list atomically (temp file + ``os.replace``).

    Mirrors ``xmp_meta._atomic_write``: a reader from the other pack — or the
    other device — can never observe a torn file, and a crash mid-write leaves
    the previous list intact rather than an empty one. Raises OSError to the
    caller, which turns it into a 500; a silently swallowed write would report
    a pin as saved that is not.
    """
    payload = json.dumps(
        {"version": PINS_VERSION, "pins": list(pins)},
        indent=2,
        ensure_ascii=False,
    ).encode("utf-8")
    directory = os.path.dirname(path) or "."
    os.makedirs(directory, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=directory, prefix=".comfypins_", suffix=".tmp")
    try:
        with os.fdopen(fd, "wb") as f:
            f.write(payload)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, path)
    except Exception:
        with contextlib.suppress(OSError):
            os.unlink(tmp)
        raise
