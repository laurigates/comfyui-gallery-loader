"""Backend for the comfyui-gallery-loader pack.

GalleryLoadImage: a LoadImage variant whose UI is a card-grid picker
(see web/js/gallery_loader.js). The Python side is a thin shim — it
accepts a single STRING that is either:

  - an annotated path like ``subdir/foo.png [input]`` / ``[output]`` /
    ``[temp]``  (parsed by ``folder_paths.annotated_filepath``), or
  - an absolute filesystem path (any reachable path).

It returns ``(IMAGE, MASK, STRING)`` where STRING is the resolved
on-disk path the workflow loaded — convenient for SaveImage filename
re-use, debug, and metadata.

The list endpoint ``/gallery_loader/list`` powers the picker UI.
"""

from __future__ import annotations

import functools
import hashlib
import logging
import mimetypes
import os
import re
from collections.abc import Sequence
from email.utils import formatdate
from typing import Any

import folder_paths
import node_helpers
import numpy as np
import torch
from aiohttp import web
from PIL import Image, ImageOps, ImageSequence
from server import PromptServer

try:
    # ComfyUI imports custom_nodes as packages, so the sibling module must
    # be pulled in relatively — a bare ``import xmp_meta`` raises
    # ModuleNotFoundError at load time because the pack dir isn't on sys.path.
    from . import image_meta, pins_store, thumb_cache, xmp_meta
except ImportError:
    # Pytest imports this module flat (pack root on sys.path via pyproject's
    # ``pythonpath = ["."]``); fall back to the absolute import.
    import image_meta
    import pins_store
    import thumb_cache
    import xmp_meta

log = logging.getLogger("comfyui-gallery-loader")

IMG_EXTS = {".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp", ".tiff", ".tif", ".avif"}
VIDEO_EXTS = {".mp4", ".webm", ".mov", ".mkv", ".avi", ".m4v", ".mpg", ".mpeg"}
# Extensions the /gallery_loader/file endpoint will stream raw to the
# browser (for previews in type=path mode where /api/view doesn't apply).
# Keep this narrow — it's an arbitrary-path read.
STREAMABLE_EXTS = IMG_EXTS | VIDEO_EXTS

SANDBOXED_TYPES = ("input", "output", "temp")

# ---------------------------------------------------------------------------
# Safe View — server-side hide
# ---------------------------------------------------------------------------
#
# DISCRETION, NOT ACCESS CONTROL. This drops matching rows from a listing so
# they never reach the browser; it is not an authorization boundary. Every
# other endpoint (/thumb, /file, /metadata, /rating) still serves the file to
# anyone who addresses it directly, exactly as before. Nothing here is a
# permission check and nothing downstream should be written as though it is.
#
# The three functions below are a DELIBERATE PORT of the frontend's, in
# @laurigates/comfy-modal-kit `src/safe-view.ts` (`tokenize`, `parseKeywords`,
# `isSensitive`). The two must agree file-for-file: the frontend blurs what it
# thinks matches while the backend drops what IT thinks matches, so any
# divergence shows up as a file that is hidden in one pack and plain in the
# other — or, worse, as a card blurred here and readable in the sibling pack
# over the same file on disk. `comfyui-image-browser` carries the identical
# port; the contract is pinned in both repos' tests.
#
# WHOLE TOKENS, NEVER SUBSTRINGS. Every haystack is split on non-alphanumerics
# and compared as complete tokens, so `nsfw` matches `output/nsfw/pic.png` and
# `my_nsfw_pic.png` but `ass` does NOT match `assets/` and `nsfw` does NOT
# match `nsfwish.png`. A substring matcher passes every positive test and
# silently hides unrelated work, which the user cannot distinguish from a
# deliberate match — both look like a file that simply is not there.
_SAFE_TOKEN_SPLIT = re.compile(r"[^a-z0-9]+")
_SAFE_KEYWORD_SPLIT = re.compile(r"[\s,]+")
_SAFE_KEYWORD_STRIP = re.compile(r"[^a-z0-9]")


def _safe_tokens(value: str) -> set[str]:
    """Lowercase alphanumeric tokens of ``value``. Port of the kit's ``tokenize``."""
    if not value:
        return set()
    return {t for t in _SAFE_TOKEN_SPLIT.split(value.lower()) if t}


def _parse_safe_keywords(raw: str) -> list[str]:
    """Normalize the ``safe_kw`` parameter. Port of the kit's ``parseKeywords``.

    Commas and/or whitespace separate; each keyword is lowercased and stripped
    of every non-alphanumeric character, because it is compared against tokens
    produced by :func:`_safe_tokens` and a keyword carrying punctuation could
    never equal one of those. Deduped, order preserved.
    """
    out: list[str] = []
    seen: set[str] = set()
    for piece in _SAFE_KEYWORD_SPLIT.split(raw or ""):
        kw = _SAFE_KEYWORD_STRIP.sub("", piece.lower())
        if not kw or kw in seen:
            continue
        seen.add(kw)
        out.append(kw)
    return out


def _safe_join(*parts: str) -> str:
    """Join non-empty path parts with '/'. Only ever builds a LOGICAL address."""
    return "/".join(p.strip("/") for p in parts if p and p.strip("/"))


def _is_sensitive(name: str, path: str, keywords: Sequence[str], tags: Sequence[str] = ()) -> bool:
    """Whether ``name`` (in folder ``path``, carrying ``tags``) matches any
    keyword as a whole token.

    ``path`` must be the LOGICAL address the frontend also sees — for a
    sandboxed root that is ``output/nsfw/2026-08-04``, never the resolved OS
    path. Feeding the OS path in would put every segment of
    ``/home/<user>/ComfyUI/output`` into the haystack, so a keyword of
    ``comfyui`` would hide the entire library while the frontend — which never
    sees those segments — kept showing it.

    ``tags`` are the file's ``dc:subject`` keywords. Each is TOKENIZED like any
    other haystack rather than compared whole, matching the kit's ``isSensitive``
    exactly: a file tagged ``nsfw art`` in digiKam matches the keyword ``nsfw``,
    and a file tagged ``assets`` still does not match ``ass``.
    """
    if not keywords:
        return False
    hay = _safe_tokens(name) | _safe_tokens(path)
    for tag in tags:
        hay |= _safe_tokens(tag)
    return any(kw in hay for kw in keywords)


# The media a listing may ever enumerate. /list is a read of NAMES only, but a
# recursive listing turns "enumerate one directory" into "enumerate the whole
# tree in one request", so the extensions parameter is clamped to this rather
# than passed through — see gallery_list.
MEDIA_EXTS = IMG_EXTS | VIDEO_EXTS

# Upper bound on files a recursive ("flat") listing RETURNS. The walk itself
# always covers the whole subtree (see FLAT_WALK_CAP) and the cap is applied
# after an mtime sort, so a truncated response holds the newest N files — not
# whichever N a directory-order walk happened to reach first. That distinction
# is the whole point of the view: "find the render I just made".
FLAT_LIST_CAP = 5000

# Backstop on the cheap enumeration pass. Phase 1 only stats entries (no file
# opens), so this is far higher than FLAT_LIST_CAP; it exists so a pathological
# tree cannot pin the event loop indefinitely.
FLAT_WALK_CAP = 200_000

# Upper bound on a NON-recursive listing. Same newest-N semantics. Without it a
# 50k-file directory costs 50k header opens plus 50k rating reads on the event
# loop, and 50k cards in one grid is well past usable either way.
DIR_LIST_CAP = 5000

# How far past the cap the keyword tier may keep probing to top a page back up
# (see _probe_newest). Only applies when Safe View hiding is on: with it off the
# loop probes exactly `cap` rows, which is what it always did.
PROBE_BUDGET_FACTOR = 4

# Image-content mimetypes guard for the picker; covers the common cases
# that mimetypes.guess_type misses on this distro.
mimetypes.add_type("image/webp", ".webp")
mimetypes.add_type("image/avif", ".avif")


def _is_image_file(name: str) -> bool:
    return os.path.splitext(name)[1].lower() in IMG_EXTS


def _parse_extensions(raw: str) -> set[str]:
    """Parse a CSV extension list ('mp4,webm' or '.png,.jpg') to a normalized set.

    Returns IMG_EXTS when raw is empty (backward-compatible default for the
    list endpoint).
    """
    if not raw:
        return IMG_EXTS
    out: set[str] = set()
    for part in raw.split(","):
        ext = part.strip().lower()
        if not ext:
            continue
        if not ext.startswith("."):
            ext = "." + ext
        out.add(ext)
    return out or IMG_EXTS


def _resolve_input_string(image: str) -> str:
    """Resolve a node 'image' string to an absolute path.

    Accepts annotated forms (``foo.png [input]``) and absolute paths.
    Absolute paths are returned as-is; relative paths fall back to
    input dir, matching core LoadImage behavior.
    """
    image = (image or "").strip()
    if not image:
        raise ValueError("Gallery Load Image: no image selected.")

    # Annotated path (relative to input/output/temp)
    if image.endswith("[input]") or image.endswith("[output]") or image.endswith("[temp]"):
        return folder_paths.get_annotated_filepath(image)

    # Absolute path — trust it (user typed it; same posture as VHS path nodes).
    if os.path.isabs(image):
        return image

    # Bare relative path — fall back to input dir.
    return folder_paths.get_annotated_filepath(image)


def _load_image_tensor(path: str) -> tuple[torch.Tensor, torch.Tensor]:
    """Same loading logic as core LoadImage, minus the asset-resolver bits."""
    img = node_helpers.pillow(Image.open, path)

    output_images: list[torch.Tensor] = []
    output_masks: list[torch.Tensor] = []
    w: int | None = None
    h: int | None = None

    for frame in ImageSequence.Iterator(img):
        frame = node_helpers.pillow(ImageOps.exif_transpose, frame)
        image = frame.convert("RGB")

        if not output_images:
            w, h = image.size

        if image.size != (w, h):
            continue

        arr = np.array(image).astype(np.float32) / 255.0
        tensor = torch.from_numpy(arr)[None,]

        if "A" in frame.getbands():
            mask_arr = np.array(frame.getchannel("A")).astype(np.float32) / 255.0
            mask = 1.0 - torch.from_numpy(mask_arr)
        else:
            mask = torch.zeros((64, 64), dtype=torch.float32, device="cpu")

        output_images.append(tensor)
        output_masks.append(mask.unsqueeze(0))

    if not output_images:
        raise RuntimeError(f"Gallery Load Image: no decodable frames in {path!r}.")

    return torch.cat(output_images, dim=0), torch.cat(output_masks, dim=0)


class GalleryLoadImage:
    """LoadImage with a card-grid picker UI."""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                # The UI is driven by web/js/gallery_loader.js, which uses
                # `gallery_loader: True` to identify the widget to take over.
                "image": (
                    "STRING",
                    {
                        "default": "",
                        "multiline": False,
                        "gallery_loader": True,
                        "placeholder": "Pick an image from the gallery below",
                    },
                ),
            },
        }

    CATEGORY = "image"
    RETURN_TYPES = ("IMAGE", "MASK", "STRING")
    RETURN_NAMES = ("image", "mask", "path")
    FUNCTION = "load"

    def load(self, image: str):
        path = _resolve_input_string(image)
        if not os.path.isfile(path):
            raise FileNotFoundError(f"Gallery Load Image: file not found: {path!r}")
        img, mask = _load_image_tensor(path)
        return (img, mask, path)

    @classmethod
    def IS_CHANGED(cls, image: str):
        try:
            path = _resolve_input_string(image)
        except Exception:
            return image
        if not os.path.isfile(path):
            return image
        m = hashlib.sha256()
        # Hash mtime + size — cheaper than full content hash and good enough
        # to detect overwrites of the same filename.
        stat = os.stat(path)
        m.update(f"{path}|{stat.st_mtime_ns}|{stat.st_size}".encode())
        return m.hexdigest()

    @classmethod
    def VALIDATE_INPUTS(cls, image: str):
        if not (image or "").strip():
            return "Gallery Load Image: no image selected."
        try:
            path = _resolve_input_string(image)
        except Exception as exc:
            return str(exc)
        if not os.path.isfile(path):
            return f"Gallery Load Image: file not found: {path}"
        return True


# ---------------------------------------------------------------------------
# Listing endpoint
# ---------------------------------------------------------------------------


def _is_bare_name(name: Any) -> bool:
    """True if ``name`` is a single path component with no traversal."""
    return (
        isinstance(name, str)
        and bool(name)
        and os.path.basename(name) == name
        and name not in (".", "..")
    )


def _resolve_listing_base(type_name: str, subfolder: str, abs_path: str) -> tuple[str | None, str]:
    """Return (base_dir, error_msg). On success error_msg == ''."""
    if type_name in SANDBOXED_TYPES:
        root = folder_paths.get_directory_by_type(type_name)
        if not root:
            return None, f"unknown type: {type_name}"
        target = os.path.abspath(os.path.join(root, subfolder or ""))
        # Constrain to the root for the sandboxed types.
        if os.path.commonpath([target, os.path.abspath(root)]) != os.path.abspath(root):
            return None, "subfolder escapes root"
        return target, ""
    if type_name == "path":
        if not abs_path:
            return None, "missing path"
        target = os.path.abspath(os.path.expanduser(abs_path))
        return target, ""
    return None, f"unknown type: {type_name}"


def _validate_media_address(body: Any) -> tuple[dict[str, Any] | None, str]:
    """Validate the ``{type, subfolder|path, name}`` half of a metadata-write
    POST body. Returns (parsed, error).

    Enforces a bare (traversal-free) filename and the image/video extension
    whitelist — the same security perimeter as the /thumb and /file endpoints.
    Path resolution stays in the handler. Shared by /rating and /tag so the two
    writes cannot drift into addressing files differently.
    """
    if not isinstance(body, dict):
        return None, "invalid body"
    name = body.get("name")
    if not isinstance(name, str) or not name:
        return None, "invalid name"
    if os.path.basename(name) != name or name in (".", ".."):
        return None, "invalid name"
    type_name = body.get("type", "input")
    if not isinstance(type_name, str):
        return None, "invalid type"
    if os.path.splitext(name)[1].lower() not in (IMG_EXTS | VIDEO_EXTS):
        return None, "unsupported file type"
    return {
        "type": type_name,
        "subfolder": body.get("subfolder") or "",
        "path": body.get("path") or "",
        "name": name,
    }, ""


def _validate_rating_request(body: Any) -> tuple[dict[str, Any] | None, str]:
    """Validate a /gallery_loader/rating POST body. Returns (parsed, error)."""
    parsed, err = _validate_media_address(body)
    if err:
        return None, err
    assert parsed is not None
    rating = body.get("rating")
    # bool is an int subclass — reject it explicitly.
    if isinstance(rating, bool) or not isinstance(rating, int) or not (0 <= rating <= 5):
        return None, "rating must be an integer 0..5"
    parsed["rating"] = rating
    return parsed, ""


def _validate_tag_request(body: Any) -> tuple[dict[str, Any] | None, str]:
    """Validate a /gallery_loader/tag POST body. Returns (parsed, error).

    ``{..., tag: "nsfw", present: true}`` — ONE keyword per call, added or
    removed. The keyword is normalized by ``xmp_meta.normalize_tag`` (the same
    function the writer uses), so a value that would not survive the round trip
    is rejected here rather than written and silently lost.
    """
    parsed, err = _validate_media_address(body)
    if err:
        return None, err
    assert parsed is not None
    tag = xmp_meta.normalize_tag(body.get("tag"))
    if not tag:
        return None, "invalid tag"
    present = body.get("present")
    if not isinstance(present, bool):
        return None, "present must be a boolean"
    parsed["tag"] = tag
    parsed["present"] = present
    return parsed, ""


def _resolve_sandboxed_file(type_name: str, subfolder: str, name: str) -> tuple[str | None, str]:
    """Resolve a MUTATION target to an absolute path inside a sandboxed root.

    Reads deliberately reach further than writes. ``/file``, ``/thumb`` and
    ``/metadata`` accept ``type=path`` and serve any absolute path behind an
    extension gate, because the VHS path browser has to preview files that are
    not under input/output/temp at all. A write has no such need and must not
    inherit that reach: ``xmp_meta`` rewrites a PNG/JPEG in place, and for
    every other container it CREATES ``<path>.xmp``. Pointing either at an
    arbitrary path is an arbitrary file write.

    So the first statement is the type gate, and the remaining four are
    stacked behind it: bare filename, media extension, lexical containment,
    and a realpath re-check.

    The last one is not redundant. ``os.path.abspath`` is purely textual — it
    collapses ``..`` and joins, and resolves no symlinks — so a link inside
    the root (``output/link -> /``) satisfies the lexical check while landing
    the target outside. ``os.path.realpath`` is anchored on the ROOT rather
    than on the resolved base, because anchoring on the base is exactly what a
    traversed link would move.

    Consequence worth knowing: a genuinely symlinked subfolder
    (``output/renders -> /mnt/nas/renders``) can be listed and previewed but
    not rated or tagged. Reads are unaffected — ``_resolve_listing_base``
    keeps no realpath gate, deliberately.
    """
    if type_name not in SANDBOXED_TYPES:
        return None, "writes are only allowed in input/output/temp"
    if not _is_bare_name(name):
        return None, "invalid name"
    if os.path.splitext(name)[1].lower() not in (IMG_EXTS | VIDEO_EXTS):
        return None, "unsupported file type"
    base, err = _resolve_listing_base(type_name, subfolder, "")
    if err:
        return None, err
    assert base is not None
    target = os.path.abspath(os.path.join(base, name))
    if os.path.commonpath([target, base]) != base:
        return None, "name escapes root"
    root = os.path.realpath(str(folder_paths.get_directory_by_type(type_name)))
    if os.path.commonpath([os.path.realpath(target), root]) != root:
        return None, "name escapes root"
    return target, ""


def _resolve_write_target(parsed: dict[str, Any]) -> tuple[str | None, str, int]:
    """Absolute path for a validated metadata-write address, or (None, error,
    status). Shared by /rating and /tag.

    ``parsed["path"]`` is carried by the request grammar and deliberately
    ignored here — it is the ``type=path`` address, which the resolver above
    refuses outright.
    """
    target, err = _resolve_sandboxed_file(parsed["type"], parsed["subfolder"], parsed["name"])
    if err:
        return None, err, 400
    assert target is not None
    if not os.path.isfile(target):
        return None, "file not found", 404
    return target, "", 200


def _scan_file_entry(
    path: str, name: str, ext: str, st: os.stat_result, image_subset: set[str]
) -> dict[str, Any]:
    """Build one listing row for a file.

    Shared by the flat and non-flat listers so both emit an identical shape —
    the flat one then adds ``subpath`` on top. Both probes are best-effort and
    swallow their own failures: a listing must not fail because one file is
    unreadable.
    """
    width: int | None = None
    height: int | None = None
    if ext in image_subset:
        try:
            # PIL.Image.open is lazy — only the header is read until pixel
            # access, so .size is cheap.
            with Image.open(path) as im:
                width, height = im.size
        except Exception as exc:
            log.debug("size probe failed for %s: %s", path, exc)
    try:
        # ONE XMP read for both. The rating and the dc:subject keywords come
        # out of the same packet, so asking for them separately would double
        # the file opens this listing already pays for.
        rating, tags = xmp_meta.read_meta_cached(path, st)
    except Exception as exc:
        log.debug("metadata read failed for %s: %s", path, exc)
        rating, tags = 0, []
    return {
        "name": name,
        "mtime": st.st_mtime,
        "size": st.st_size,
        "width": width,
        "height": height,
        "ext": ext,
        "rating": rating,
        "tags": tags,
    }


# (mtime, subpath, name, ext, path, stat) — what phase 1 collects per file.
_FoundEntry = tuple[float, str, str, str, str, os.stat_result]


def _probe_newest(
    found: list[_FoundEntry],
    image_subset: set[str],
    cap: int,
    walk_truncated: bool,
    *,
    with_subpath: bool,
    safe_keywords: Sequence[str] = (),
    safe_base: str = "",
) -> tuple[list[dict[str, Any]], bool]:
    """Sort newest-first, slice to ``cap``, then probe only the survivors.

    The ordering matters. Probing during enumeration and stopping at the cap
    truncates in DIRECTORY order, which silently omits the newest render — the
    one thing a user opening this view is looking for. Sorting first costs an
    extra pass over cheap tuples and makes the cap mean "the newest N".

    Ties break on (subpath, name) so the slice is deterministic for same-mtime
    files; a batch render writes many within one clock tick.

    ``with_subpath`` is False for a non-recursive listing, which must omit the
    key ENTIRELY rather than emit an empty string — the frontend distinguishes
    "flat listing, file at top level" from "folder listing" by its presence.

    SAFE VIEW HIDING HAPPENS HERE, ABOVE THE CAP, and that is the whole reason
    the filter lives in this function rather than at either call site. Applying
    it after the slice would let a folder of mostly-sensitive files spend the
    entire newest-N budget on rows that are then dropped, so the user gets a
    near-empty grid and no way to tell it from an empty folder. Filtering first
    means the cap is spent on rows that actually ship: a full page of the rest.
    ``truncated`` is computed from what the caller actually received for the
    same reason — it must describe the listing that shipped, not one it never
    saw.

    The filter has TWO TIERS and they cannot both run above the cap. Name and
    path are free (they are already in hand), so they filter the whole list up
    front. The ``dc:subject`` keyword tier needs the XMP read, which is the
    expensive probe the cap exists to bound — so instead of probing everything,
    the loop below probes in newest-first order and TOPS UP: a row dropped for
    its tags is replaced by probing one more. That keeps the "a full page of
    the rest" property of tier one without paying tier one's price, and costs
    exactly the same number of probes as before whenever nothing is tagged.
    ``PROBE_BUDGET_FACTOR`` bounds the pathological case (a whole tree tagged),
    where the honest answer is a short page marked ``truncated``.
    """
    if safe_keywords:
        found = [
            entry
            for entry in found
            if not _is_sensitive(entry[2], _safe_join(safe_base, entry[1]), safe_keywords)
        ]
    found.sort(key=lambda f: (-f[0], f[1], f[2]))
    budget = cap * PROBE_BUDGET_FACTOR if safe_keywords else cap
    files: list[dict[str, Any]] = []
    probed = 0
    for _mtime, subpath, name, ext, path, st in found:
        if len(files) >= cap or probed >= budget:
            break
        fd = _scan_file_entry(path, name, ext, st, image_subset)
        probed += 1
        if safe_keywords and _is_sensitive(
            name, _safe_join(safe_base, subpath), safe_keywords, fd["tags"]
        ):
            continue
        if with_subpath:
            fd["subpath"] = subpath
        files.append(fd)
    truncated = walk_truncated or probed < len(found)
    return files, truncated


def _walk_files(
    base: str,
    exts: set[str],
    image_subset: set[str],
    cap: int,
    *,
    safe_keywords: Sequence[str] = (),
    safe_base: str = "",
) -> tuple[list[dict[str, Any]], bool]:
    """Recursively collect files under ``base``, newest first, capped.

    Two phases: a cheap stat-only enumeration of the whole subtree, then the
    expensive probes (PIL header open + XMP rating read) on only the files that
    will actually ship. See _probe_newest for why the sort precedes the slice.
    """
    # Phase 1 — cheap enumeration.
    found: list[_FoundEntry] = []
    walk_truncated = False
    # DFS over scandir (not os.walk) so each directory keeps DirEntry's cheap,
    # symlink-safe is_dir/is_file/stat — the same guards the flat lister uses.
    stack: list[tuple[str, str]] = [("", base)]
    while stack and not walk_truncated:
        subpath, directory = stack.pop()
        try:
            with os.scandir(directory) as it:
                subdirs: list[tuple[str, str]] = []
                for entry in it:
                    try:
                        if entry.name.startswith("."):
                            continue
                        if entry.is_dir(follow_symlinks=False):
                            if entry.name in ("clipspace", "__pycache__"):
                                continue
                            child = f"{subpath}/{entry.name}" if subpath else entry.name
                            subdirs.append((child, entry.path))
                        elif entry.is_file(follow_symlinks=False):
                            ext = os.path.splitext(entry.name)[1].lower()
                            if ext not in exts:
                                continue
                            st = entry.stat(follow_symlinks=False)
                            found.append((st.st_mtime, subpath, entry.name, ext, entry.path, st))
                            if len(found) >= FLAT_WALK_CAP:
                                walk_truncated = True
                                break
                    except OSError:
                        continue
                # Descend in name order (reversed onto the LIFO stack) so the
                # enumeration frontier is predictable if the backstop ever bites.
                subdirs.sort(key=lambda s: s[0].lower(), reverse=True)
                stack.extend(subdirs)
        except OSError:
            # An unreadable subdirectory is skipped, not fatal — one bad
            # permission deep in the tree must not kill the whole listing.
            continue

    return _probe_newest(
        found,
        image_subset,
        cap,
        walk_truncated,
        with_subpath=True,
        safe_keywords=safe_keywords,
        safe_base=safe_base,
    )


@PromptServer.instance.routes.get("/gallery_loader/list")
async def gallery_list(request: web.Request) -> web.Response:
    q = request.rel_url.query
    type_name = q.get("type", "input")
    subfolder = q.get("subfolder", "")
    abs_path = q.get("path", "")
    # Clamp to media. This is a name-only read, but recursion turns it from a
    # directory-at-a-time enumeration primitive into a whole-tree one, and
    # `?recursive=1&extensions=.txt,.safetensors` has no legitimate caller.
    #
    # The clamp lives HERE and not inside _parse_extensions on purpose: that
    # helper falls back to IMG_EXTS on an empty result, which would re-expand
    # an empty intersection. Directory mode depends on the current behaviour —
    # it passes `.__none__` to get an empty listing, and `{".__none__"} &
    # MEDIA_EXTS` is still empty, so it keeps working. Moving the clamp into
    # the parser would silently start listing every image there.
    exts = _parse_extensions(q.get("extensions", "")) & MEDIA_EXTS
    # Width/height probing only makes sense for image entries; for video
    # listings we skip the PIL.Image.open() call entirely.
    image_subset = exts & IMG_EXTS
    # Flat/recursive listing is a sandboxed-root affordance only — recursing an
    # arbitrary base path (type=path, e.g. models/) is out of scope and could
    # be enormous, so the flag is ignored there. An empty extension set would
    # walk the whole tree to return nothing, so don't bother.
    recursive = (
        q.get("recursive", "") in ("1", "true", "yes")
        and type_name in SANDBOXED_TYPES
        and bool(exts)
    )

    # Safe View: drop matching rows server-side so they never reach the browser.
    # Only in effect when the caller asks for BOTH — a keyword list and the hide
    # flag. The frontend omits the pair entirely unless the user turned hiding
    # on, so the default request URL stays byte-identical to what it has always
    # been. An unrecognised safe_hide value filters nothing rather than 400ing,
    # matching how `recursive` above treats its own input.
    safe_hide = q.get("safe_hide", "") in ("1", "true", "yes")
    safe_keywords = _parse_safe_keywords(q.get("safe_kw", "")) if safe_hide else []

    base, err = _resolve_listing_base(type_name, subfolder, abs_path)
    if err:
        return web.json_response({"ok": False, "error": err}, status=400)
    assert base is not None

    # The LOGICAL folder address, which is what the frontend matches against
    # too: `output/nsfw/2026-08-04` for a sandboxed root, and the absolute
    # directory for type=path (there the OS path IS the logical path, so both
    # sides see the same string). Never the resolved OS path for a sandboxed
    # root — see _is_sensitive.
    safe_base = base if type_name == "path" else _safe_join(type_name, subfolder)

    if not os.path.isdir(base):
        return web.json_response(
            {
                "ok": True,
                "type": type_name,
                "subfolder": subfolder,
                "path": base,
                "dirs": [],
                "files": [],
                "exists": False,
                "truncated": False,
            }
        )

    dirs: list[dict[str, Any]] = []
    files: list[dict[str, Any]] = []
    if recursive:
        # Flat view: no folder cards, files carry their relative subpath.
        files, truncated = _walk_files(
            base,
            exts,
            image_subset,
            FLAT_LIST_CAP,
            safe_keywords=safe_keywords,
            safe_base=safe_base,
        )
    else:
        found: list[_FoundEntry] = []
        try:
            with os.scandir(base) as it:
                for entry in it:
                    try:
                        if entry.name.startswith("."):
                            continue
                        if entry.is_dir(follow_symlinks=False):
                            # Skip clipspace (matches LoadImage convention) and __pycache__
                            if entry.name in ("clipspace", "__pycache__"):
                                continue
                            # A folder is matched by NAME ONLY — it carries no
                            # metadata to read, and the kit documents the same
                            # rule frontend-side. Without this an `nsfw/` card
                            # would survive as a visible (and now empty)
                            # doorway into the thing being hidden.
                            if safe_keywords and _is_sensitive(entry.name, "", safe_keywords):
                                continue
                            st = entry.stat(follow_symlinks=False)
                            dirs.append({"name": entry.name, "mtime": st.st_mtime})
                        elif entry.is_file(follow_symlinks=False):
                            ext = os.path.splitext(entry.name)[1].lower()
                            if ext not in exts:
                                continue
                            st = entry.stat(follow_symlinks=False)
                            found.append((st.st_mtime, "", entry.name, ext, entry.path, st))
                    except OSError:
                        # Broken symlink / permission error — skip silently
                        continue
        except PermissionError as exc:
            return web.json_response({"ok": False, "error": str(exc)}, status=403)
        except OSError as exc:
            return web.json_response({"ok": False, "error": str(exc)}, status=500)
        # Same enumerate → sort → slice → probe shape as the recursive path, so
        # a huge single directory costs the expensive probes only for the files
        # that ship. Newest first — the common case is "I just rendered this".
        files, truncated = _probe_newest(
            found,
            image_subset,
            DIR_LIST_CAP,
            False,
            with_subpath=False,
            safe_keywords=safe_keywords,
            safe_base=safe_base,
        )

    dirs.sort(key=lambda d: d["name"].lower())

    return web.json_response(
        {
            "ok": True,
            "type": type_name,
            "subfolder": subfolder,
            "path": base,
            "dirs": dirs,
            "files": files,
            "exists": True,
            "truncated": truncated,
        }
    )


@PromptServer.instance.routes.get("/gallery_loader/base")
async def gallery_base(request: web.Request) -> web.Response:
    """Expose ComfyUI's well-known directories.

    The modal's VHS path-mode opens at base_path by default, so the user can
    navigate into models/, output/, custom_nodes/, etc. Frontend keeps no
    hard-coded paths.
    """
    return web.json_response(
        {
            "ok": True,
            "base_path": folder_paths.base_path,
            "input_dir": folder_paths.get_input_directory(),
            "output_dir": folder_paths.get_output_directory(),
            "temp_dir": folder_paths.get_temp_directory(),
            "user_dir": folder_paths.get_user_directory(),
        }
    )


@PromptServer.instance.routes.get("/gallery_loader/file")
async def gallery_file(request: web.Request) -> web.Response:
    """Stream a file at an absolute path (whitelisted extensions only).

    Used by the picker to preview videos in type=path listings — core
    /api/view only serves files under input/output/temp. Extension
    whitelist (images + common video container formats) is the same
    arbitrary-path-read posture as the thumb endpoint.
    """
    q = request.rel_url.query
    abs_path = q.get("path", "")
    if not abs_path:
        return web.Response(status=400)
    path = os.path.abspath(os.path.expanduser(abs_path))
    if not os.path.isfile(path):
        return web.Response(status=404)
    ext = os.path.splitext(path)[1].lower()
    if ext not in STREAMABLE_EXTS:
        return web.Response(status=403)
    mime, _ = mimetypes.guess_type(path)
    return web.FileResponse(
        path,
        headers={
            "Content-Type": mime or "application/octet-stream",
            # Browsers reuse video posters / thumbnails aggressively; let
            # them cache for a few minutes.
            "Cache-Control": "private, max-age=300",
        },
    )


def _resolve_thumb_target(q: Any) -> tuple[str | None, str]:
    """Resolve /thumb query params to an absolute file path.

    Two addressing modes, mirroring /list:
      ?type=input|output|temp&subfolder=&name=   (sandboxed roots)
      ?path=/abs/file.png                        (arbitrary read, image-gated)
    """
    type_name = q.get("type", "path")
    if type_name in SANDBOXED_TYPES:
        name = q.get("name", "")
        if not _is_bare_name(name):
            return None, "invalid name"
        base, err = _resolve_listing_base(type_name, q.get("subfolder", ""), "")
        if err:
            return None, err
        assert base is not None
        target = os.path.abspath(os.path.join(base, name))
        if os.path.commonpath([target, base]) != base:
            return None, "name escapes root"
        return target, ""
    abs_path = q.get("path", "")
    if not abs_path:
        return None, "missing path"
    return os.path.abspath(os.path.expanduser(abs_path)), ""


def _thumb_cache_dir() -> str:
    # Resolved lazily (not at import) so test stubs of folder_paths don't
    # break module load. The same <user_dir>/comfy-thumb-cache is used by
    # comfyui-image-browser — the packs share encoded thumbnails.
    return os.path.join(str(folder_paths.get_user_directory()), thumb_cache.CACHE_DIR_NAME)


@PromptServer.instance.routes.get("/gallery_loader/thumb")
async def gallery_thumb(request: web.Request) -> web.Response:
    """WebP thumbnail for any listed image — sandboxed roots AND type=path.

    Core /api/view re-encodes previews on every request with no cache
    headers, so sandboxed thumbnails are served here instead: through the
    shared on-disk cache (thumb_cache.py) with an ETag and a long max-age.
    The frontend embeds ?v=<mtime>-<size> in the URL, so a changed file
    keys a new URL and a stale cached copy can never be shown.
    """
    path, err = _resolve_thumb_target(request.rel_url.query)
    if err:
        return web.Response(status=400)
    assert path is not None
    if not os.path.isfile(path) or not _is_image_file(path):
        return web.Response(status=404)

    try:
        st = os.stat(path)
    except OSError as exc:
        log.warning("thumb stat failed for %s: %s", path, exc)
        return web.Response(status=404)
    etag = thumb_cache.etag_for(path, st)
    cache_headers = {
        "ETag": etag,
        "Last-Modified": formatdate(st.st_mtime, usegmt=True),
        "Cache-Control": "private, max-age=604800, immutable",
    }
    if request.headers.get("If-None-Match") == etag:
        return web.Response(status=304, headers=cache_headers)

    data = thumb_cache.get_thumb(path, st, _thumb_cache_dir())
    if data is None:
        return web.Response(status=500)
    return web.Response(body=data, content_type="image/webp", headers=cache_headers)


@PromptServer.instance.routes.get("/gallery_loader/metadata")
async def gallery_metadata(request: web.Request) -> web.Response:
    """Embedded generation metadata for one image — sandboxed roots AND type=path.

    Same dual addressing as /thumb (``_resolve_thumb_target``), and images
    only: the gate is IMG_EXTS, not STREAMABLE_EXTS, so no video metadata is
    read and no new extension enters the perimeter.

    The whitelist is asserted **before** ``os.path.isfile`` — the opposite
    order to /file, which stats an arbitrary caller-supplied path before
    checking the extension (a pre-existing wart; new read endpoints follow
    this order). It also splits /thumb's single 404 in two, because a
    non-whitelisted extension is a bad request (400), not a missing file.

    No cache headers: this is a one-shot tap-to-open read, so duplicating
    /thumb's ETag scheme would buy nothing.
    """
    path, err = _resolve_thumb_target(request.rel_url.query)
    if err:
        return web.json_response({"ok": False, "error": err}, status=400)
    assert path is not None
    if not _is_image_file(path):
        return web.json_response({"ok": False, "error": "unsupported file type"}, status=400)
    if not os.path.isfile(path):
        return web.json_response({"ok": False, "error": "file not found"}, status=404)

    raw, truncated = image_meta.read_raw_metadata(path)
    source, summary = image_meta.parse_generation_meta(raw)
    # The container label comes from the extension, keeping one source of
    # truth with the rest of the pack; an image whose format has no parser
    # (a .gif from IMG_EXTS) answers 200 with empty metadata, never a 500.
    fmt = image_meta.FORMAT_EXTS.get(os.path.splitext(path)[1].lower(), "")
    return web.json_response(
        {
            "ok": True,
            "format": fmt,
            "source": source,
            "summary": summary,
            "raw": raw,
            "truncated": truncated,
        }
    )


# ---------------------------------------------------------------------------
# Mutating POST routes
# ---------------------------------------------------------------------------
#
# aiohttp never inspects Content-Type on the way in. Verified against the
# installed aiohttp 3.14.3: BaseRequest.json() calls text(), which calls
# read() and decodes with .charset — the header is consulted for the encoding
# and for nothing else. A body is parsed as JSON whatever it was labelled.
#
# That matters because a cross-origin form POST with enctype="text/plain" is a
# CORS-SIMPLE request: the browser sends it with no preflight, and although the
# attacker cannot read the response, the write has already happened. Requiring
# application/json makes every cross-origin POST here non-simple, so the
# browser must preflight it first, and the preflight only succeeds where the
# operator has deliberately enabled CORS.
#
# Deliberately NOT re-implemented here: the Origin/Host compare. ComfyUI core
# already applies create_origin_only_middleware() to every route in the app
# (server.py, and it is skipped precisely when --enable-cors-header opts out of
# it), and a second copy would need a URL parser from the standard library
# whose module name is itself one of the registry scanner's network tripwires
# — see tests/test_publish_hygiene.py. Adding a scanner finding to the file
# under appeal to duplicate a check core already performs is a bad trade.
#
# The guard is applied by the decorator that REGISTERS the route rather than by
# hand inside each handler, so a new mutating route cannot be added without it.
# tests/test_write_containment.py enumerates the registry this fills and reads
# the module's own decorators back to prove nothing bypassed it.

JSON_MEDIA_TYPE = "application/json"

MUTATING_POST_ROUTES: dict[str, Any] = {}


def _mutating_post(path: str):
    """Register a mutating POST handler behind the JSON Content-Type guard."""

    def deco(fn):
        @functools.wraps(fn)
        async def guarded(request: Any) -> web.Response:
            media_type = (request.headers.get("Content-Type") or "").split(";", 1)[0]
            if media_type.strip().lower() != JSON_MEDIA_TYPE:
                return web.json_response(
                    {"ok": False, "error": "Content-Type must be application/json"},
                    status=415,
                )
            return await fn(request)

        MUTATING_POST_ROUTES[path] = guarded
        return PromptServer.instance.routes.post(path)(guarded)

    return deco


@_mutating_post("/gallery_loader/rating")
async def gallery_set_rating(request: web.Request) -> web.Response:
    """Persist a 0..5 star rating into a file's XMP (or a sidecar).

    Body: ``{type, subfolder|path, name, rating}`` — the same addressing
    the picker already uses. Rating is metadata-only; the value contract
    (what the widget commits) is untouched.
    """
    try:
        body = await request.json()
    except Exception:
        return web.json_response({"ok": False, "error": "invalid json"}, status=400)

    parsed, err = _validate_rating_request(body)
    if err:
        return web.json_response({"ok": False, "error": err}, status=400)
    assert parsed is not None

    target, terr, status = _resolve_write_target(parsed)
    if target is None:
        return web.json_response({"ok": False, "error": terr}, status=status)

    ok, backend = xmp_meta.write_rating(target, parsed["rating"])
    if not ok:
        return web.json_response({"ok": False, "error": backend}, status=500)
    return web.json_response({"ok": True, "rating": parsed["rating"], "backend": backend})


@_mutating_post("/gallery_loader/tag")
async def gallery_set_tag(request: web.Request) -> web.Response:
    """Add or remove ONE ``dc:subject`` keyword on a file's XMP (or sidecar).

    Body: ``{type, subfolder|path, name, tag, present}`` — the same addressing
    the rating write uses. ``present: true`` adds the keyword, ``false``
    removes it; the file's other keywords, its rating, and every foreign
    property are preserved (``xmp_meta.write_tags`` is a delta).

    The response carries the file's keywords AFTER the write, read back from
    what was actually written rather than echoed from the request: a keyword
    the writer normalized differently, or one that was already there, must not
    come back looking like something else got stored.

    This is a keyword write, not an access-control gate. Marking a file
    sensitive changes what Safe View hides; it does not change what any
    endpoint will serve to a caller that addresses the file directly.
    """
    try:
        body = await request.json()
    except Exception:
        return web.json_response({"ok": False, "error": "invalid json"}, status=400)

    parsed, err = _validate_tag_request(body)
    if err:
        return web.json_response({"ok": False, "error": err}, status=400)
    assert parsed is not None

    target, terr, status = _resolve_write_target(parsed)
    if target is None:
        return web.json_response({"ok": False, "error": terr}, status=status)

    tag = parsed["tag"]
    present = parsed["present"]
    ok, backend = xmp_meta.write_tags(
        target, add=[tag] if present else [], remove=[] if present else [tag]
    )
    if not ok:
        return web.json_response({"ok": False, "error": backend}, status=500)
    return web.json_response(
        {
            "ok": True,
            "tags": xmp_meta.read_tags(target, head_only=False),
            "backend": backend,
        }
    )


# ---------------------------------------------------------------------------
# Pins — folders AND individual media, shared across packs and devices
# ---------------------------------------------------------------------------
#
# The list itself lives in <user_dir>/comfy-pins.json (pins_store.py), which is
# what makes a pin set on a phone show up on the desktop and a pin set in
# comfyui-image-browser show up here: both are browsers against ONE ComfyUI, and
# the localStorage list this replaces structurally could not span either gap.
#
# The two handlers below are deliberately near-identical to their twins in
# comfyui-image-browser — same delta grammar, same response shape — so the two
# packs cannot drift into disagreeing about a file they share.


def _pins_file() -> str:
    # Resolved lazily (not at import) so a test stub of folder_paths doesn't
    # break module load — same reason as _thumb_cache_dir above.
    return pins_store.pins_path(str(folder_paths.get_user_directory()))


def _resolve_pin(pin: dict[str, Any]) -> str | None:
    """Absolute path for a pin, or None when it is not addressable.

    ``pins_store.normalize_pin`` has already guaranteed a sandboxed type, a
    non-traversing subfolder and (for a file) a bare name, and
    ``_resolve_listing_base`` re-asserts containment — so the only gate left is
    the media whitelist, applied for the same reason every other read here
    applies it. ``type=path`` never reaches this: the store refuses to hold one.
    """
    base, err = _resolve_listing_base(pin["type"], pin.get("subfolder", ""), "")
    if err or base is None:
        return None
    if pin["kind"] == "dir":
        return base
    name = pin.get("name", "")
    if not _is_bare_name(name):
        return None
    if os.path.splitext(name)[1].lower() not in STREAMABLE_EXTS:
        return None
    target = os.path.abspath(os.path.join(base, name))
    if os.path.commonpath([target, base]) != base:
        return None
    return target


def _pin_exists(pin: dict[str, Any]) -> bool:
    target = _resolve_pin(pin)
    if target is None:
        return False
    return os.path.isdir(target) if pin["kind"] == "dir" else os.path.isfile(target)


def _pin_entry(pin: dict[str, Any]) -> dict[str, Any]:
    """One pin, plus ``exists`` and (for a resolvable file) its listing stats.

    An unresolvable pin comes back with ``exists: false`` rather than being
    dropped: "the file moved" and "you never pinned it" are different facts, and
    collapsing them would make a stale pin vanish with no way to notice — the
    same reason /ratings answers ``null`` instead of ``0``. The frontend renders
    those dimmed with an unpin affordance.

    A file pin carries the SAME shape /list emits per file (``_scan_file_entry``),
    so the pinned view renders through the ordinary grid with no special-casing.
    """
    out: dict[str, Any] = dict(pin)
    target = _resolve_pin(pin)
    if target is None:
        out["exists"] = False
        return out
    if pin["kind"] == "dir":
        out["exists"] = os.path.isdir(target)
        return out
    try:
        st = os.stat(target)
    except OSError:
        out["exists"] = False
        return out
    if not os.path.isfile(target):
        out["exists"] = False
        return out
    name = str(pin.get("name", ""))
    out.update(_scan_file_entry(target, name, os.path.splitext(name)[1].lower(), st, IMG_EXTS))
    out["exists"] = True
    return out


def _pins_response(pins: list[dict[str, Any]]) -> web.Response:
    return web.json_response(
        {
            "ok": True,
            "pins": [_pin_entry(p) for p in pins],
            "max": pins_store.MAX_PINS,
        }
    )


@PromptServer.instance.routes.get("/gallery_loader/pins")
async def gallery_pins_get(request: web.Request) -> web.Response:
    """The pin list, each entry resolved (``exists`` + a file's listing stats)."""
    return _pins_response(pins_store.load_pins(_pins_file()))


@_mutating_post("/gallery_loader/pins")
async def gallery_pins_post(request: web.Request) -> web.Response:
    """Apply ONE delta: ``{op: "add"|"remove"|"prune", item?}``.

    Deliberately not a whole-list PUT. Two browsers with the picker open would
    each send their own full list and the second write would silently discard
    the first's pin — the classic lost update, and the one thing a plain JSON
    file would otherwise have needed a database to avoid. A delta read-modify-
    written inside a single aiohttp handler cannot interleave with another.

    Answers with the whole resolved list so the caller needs no follow-up GET.
    """
    try:
        body = await request.json()
    except Exception:
        return web.json_response({"ok": False, "error": "invalid json"}, status=400)
    if not isinstance(body, dict):
        return web.json_response({"ok": False, "error": "invalid body"}, status=400)

    path = _pins_file()
    updated, err = pins_store.apply_delta(
        pins_store.load_pins(path), body.get("op"), body.get("item"), exists=_pin_exists
    )
    if err:
        return web.json_response({"ok": False, "error": err}, status=400)
    try:
        pins_store.save_pins(path, updated)
    except OSError as exc:
        log.exception("pin store write failed for %s", path)
        return web.json_response({"ok": False, "error": str(exc)}, status=500)
    return _pins_response(updated)


NODE_CLASS_MAPPINGS = {"GalleryLoadImage": GalleryLoadImage}
NODE_DISPLAY_NAME_MAPPINGS = {"GalleryLoadImage": "Load Image (Gallery)"}
