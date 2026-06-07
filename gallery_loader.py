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
from io import BytesIO
from typing import Any

import folder_paths
import node_helpers
import numpy as np
import torch
from aiohttp import web
from PIL import Image, ImageOps, ImageSequence
from server import PromptServer

import xmp_meta

log = logging.getLogger("comfyui-gallery-loader")

IMG_EXTS = {".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp", ".tiff", ".tif", ".avif"}
VIDEO_EXTS = {".mp4", ".webm", ".mov", ".mkv", ".avi", ".m4v", ".mpg", ".mpeg"}
# Extensions the /gallery_loader/file endpoint will stream raw to the
# browser (for previews in type=path mode where /api/view doesn't apply).
# Keep this narrow — it's an arbitrary-path read.
STREAMABLE_EXTS = IMG_EXTS | VIDEO_EXTS

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


def _resolve_listing_base(type_name: str, subfolder: str, abs_path: str) -> tuple[str | None, str]:
    """Return (base_dir, error_msg). On success error_msg == ''."""
    if type_name in ("input", "output", "temp"):
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


@PromptServer.instance.routes.get("/gallery_loader/list")
async def gallery_list(request: web.Request) -> web.Response:
    q = request.rel_url.query
    type_name = q.get("type", "input")
    subfolder = q.get("subfolder", "")
    abs_path = q.get("path", "")
    exts = _parse_extensions(q.get("extensions", ""))
    # Width/height probing only makes sense for image entries; for video
    # listings we skip the PIL.Image.open() call entirely.
    image_subset = exts & IMG_EXTS

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
            }
        )

    dirs: list[dict[str, Any]] = []
    files: list[dict[str, Any]] = []
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
                        width: int | None = None
                        height: int | None = None
                        if ext in image_subset:
                            try:
                                # PIL.Image.open is lazy — only the header is
                                # read until pixel access, so .size is cheap.
                                with Image.open(entry.path) as im:
                                    width, height = im.size
                            except Exception:
                                pass
                        try:
                            rating = xmp_meta.read_rating_cached(entry.path, st)
                        except Exception:
                            rating = 0
                        files.append(
                            {
                                "name": entry.name,
                                "mtime": st.st_mtime,
                                "size": st.st_size,
                                "width": width,
                                "height": height,
                                "ext": ext,
                                "rating": rating,
                            }
                        )
                except OSError:
                    # Broken symlink / permission error — skip silently
                    continue
    except PermissionError as exc:
        return web.json_response({"ok": False, "error": str(exc)}, status=403)
    except OSError as exc:
        return web.json_response({"ok": False, "error": str(exc)}, status=500)

    dirs.sort(key=lambda d: d["name"].lower())
    # Newest first — the common case is "I just rendered this, pick it".
    files.sort(key=lambda f: f["mtime"], reverse=True)

    return web.json_response(
        {
            "ok": True,
            "type": type_name,
            "subfolder": subfolder,
            "path": base,
            "dirs": dirs,
            "files": files,
            "exists": True,
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


@PromptServer.instance.routes.get("/gallery_loader/thumb")
async def gallery_thumb(request: web.Request) -> web.Response:
    """Thumbnail endpoint for type=path (absolute) listings.

    For type=input|output|temp the frontend uses core /api/view, which
    has subfolder + preview scaling already. Arbitrary absolute paths
    are not allowed by /api/view, so we serve them here — small,
    rate-limited by file size, image-only.
    """
    q = request.rel_url.query
    abs_path = q.get("path", "")
    if not abs_path:
        return web.Response(status=400)
    path = os.path.abspath(os.path.expanduser(abs_path))
    if not os.path.isfile(path) or not _is_image_file(path):
        return web.Response(status=404)

    # A thumbnail is fully determined by the source file's path, mtime and
    # size, so we hand the browser cache validators and honour conditional
    # requests. Re-scrolling or reopening the picker then reuses the cached
    # copy (or gets a cheap 304) instead of re-encoding the WebP each time.
    try:
        st = os.stat(path)
    except OSError as exc:
        log.warning("thumb stat failed for %s: %s", path, exc)
        return web.Response(status=404)
    etag = '"{}"'.format(
        hashlib.sha1(f"{path}:{st.st_mtime_ns}:{st.st_size}".encode()).hexdigest()
    )
    cache_headers = {
        "ETag": etag,
        "Last-Modified": formatdate(st.st_mtime, usegmt=True),
        "Cache-Control": "private, max-age=300",
    }
    if request.headers.get("If-None-Match") == etag:
        return web.Response(status=304, headers=cache_headers)

    # Cap thumb encode size to keep big PNGs cheap.
    try:
        with Image.open(path) as im:
            im.thumbnail((512, 512))
            im = im.convert("RGB") if im.mode not in ("RGB", "RGBA") else im
            buf = BytesIO()
            im.save(buf, format="webp", quality=80)
            buf.seek(0)
            return web.Response(body=buf.read(), content_type="image/webp", headers=cache_headers)
    except Exception as exc:
        log.warning("thumb failed for %s: %s", path, exc)
        return web.Response(status=500)


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
