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

import hashlib
import logging
import mimetypes
import os
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
    from . import image_meta, thumb_cache, xmp_meta
except ImportError:
    # Pytest imports this module flat (pack root on sys.path via pyproject's
    # ``pythonpath = ["."]``); fall back to the absolute import.
    import image_meta
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


def _validate_rating_request(body: Any) -> tuple[dict[str, Any] | None, str]:
    """Validate a /gallery_loader/rating POST body. Returns (parsed, error).

    Enforces an integer 0..5 rating, a bare (traversal-free) filename, and
    the image/video extension whitelist — the same security perimeter as
    the /thumb and /file endpoints. Path resolution stays in the handler.
    """
    if not isinstance(body, dict):
        return None, "invalid body"
    rating = body.get("rating")
    # bool is an int subclass — reject it explicitly.
    if isinstance(rating, bool) or not isinstance(rating, int) or not (0 <= rating <= 5):
        return None, "rating must be an integer 0..5"
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
        "rating": rating,
    }, ""


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
        rating = xmp_meta.read_rating_cached(path, st)
    except Exception as exc:
        log.debug("rating read failed for %s: %s", path, exc)
        rating = 0
    return {
        "name": name,
        "mtime": st.st_mtime,
        "size": st.st_size,
        "width": width,
        "height": height,
        "ext": ext,
        "rating": rating,
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
    """
    found.sort(key=lambda f: (-f[0], f[1], f[2]))
    truncated = walk_truncated or len(found) > cap
    files: list[dict[str, Any]] = []
    for _mtime, subpath, name, ext, path, st in found[:cap]:
        fd = _scan_file_entry(path, name, ext, st, image_subset)
        if with_subpath:
            fd["subpath"] = subpath
        files.append(fd)
    return files, truncated


def _walk_files(
    base: str, exts: set[str], image_subset: set[str], cap: int
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

    return _probe_newest(found, image_subset, cap, walk_truncated, with_subpath=True)


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

    base, err = _resolve_listing_base(type_name, subfolder, abs_path)
    if err:
        return web.json_response({"ok": False, "error": err}, status=400)
    assert base is not None

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
        files, truncated = _walk_files(base, exts, image_subset, FLAT_LIST_CAP)
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
            found, image_subset, DIR_LIST_CAP, False, with_subpath=False
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


@PromptServer.instance.routes.post("/gallery_loader/rating")
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

    base, berr = _resolve_listing_base(parsed["type"], parsed["subfolder"], parsed["path"])
    if berr:
        return web.json_response({"ok": False, "error": berr}, status=400)
    assert base is not None

    target = os.path.abspath(os.path.join(base, parsed["name"]))
    # Belt-and-braces: the name is already separator-free, but re-assert
    # containment so the target can't escape the sandboxed root.
    if parsed["type"] in ("input", "output", "temp") and (
        os.path.commonpath([target, base]) != base
    ):
        return web.json_response({"ok": False, "error": "name escapes root"}, status=400)
    if not os.path.isfile(target):
        return web.json_response({"ok": False, "error": "file not found"}, status=404)

    ok, backend = xmp_meta.write_rating(target, parsed["rating"])
    if not ok:
        return web.json_response({"ok": False, "error": backend}, status=500)
    return web.json_response({"ok": True, "rating": parsed["rating"], "backend": backend})


NODE_CLASS_MAPPINGS = {"GalleryLoadImage": GalleryLoadImage}
NODE_DISPLAY_NAME_MAPPINGS = {"GalleryLoadImage": "Load Image (Gallery)"}
