"""XMP rating read/write for the comfyui-gallery-loader pack.

SHARED MODULE — canonical home: ``comfyui-gallery-loader/xmp_meta.py``.
Other packs (comfyui-image-browser) vendor this file **verbatim** via
their ``just sync-xmp`` recipe, with CI drift-checking the copy. Land
fixes in comfyui-gallery-loader, then re-sync the vendored copies.
Keep it pure stdlib with no ComfyUI imports so it stays portable.

Pure, stdlib-only helpers (``struct``/``zlib``/``xml.etree``/``os``/
``tempfile``) — no ComfyUI imports, so this module unit-tests in a bare
environment. The pack stays MIT and takes **no new dependencies**.

Ratings are stored as the cross-tool-standard ``xmp:Rating`` (integer
0..5; 0 = unrated) mirrored to ``MicrosoftPhoto:Rating`` (0/1/25/50/75/99
percent) so Windows Explorer shows them too.

Persistence, by priority:

1. **In-file, lossless** for PNG and JPEG via raw chunk/segment surgery —
   pixels (and ComfyUI's ``prompt``/``workflow``/``parameters`` text
   chunks) are copied verbatim; only the XMP packet is inserted/replaced.
2. **Sidecar** ``<path>.xmp`` for every other format (webp, avif, gif,
   tiff, video) and whenever an in-file write can't be done losslessly.

Reading checks in-file XMP first (so ratings set by Lightroom / Windows
are honoured), then the sidecar.
"""

from __future__ import annotations

import contextlib
import os
import tempfile
import zlib
from collections.abc import Iterator
from xml.etree import ElementTree as ET

# --- XMP namespaces ---------------------------------------------------
NS_XMP = "http://ns.adobe.com/xap/1.0/"
NS_MS = "http://ns.microsoft.com/photo/1.0/"

# --- format markers ---------------------------------------------------
PNG_SIG = b"\x89PNG\r\n\x1a\n"
PNG_XMP_KEYWORD = b"XML:com.adobe.xmp"
JPEG_XMP_PREFIX = b"http://ns.adobe.com/xap/1.0/\x00"  # 29 bytes

# --- limits -----------------------------------------------------------
MAX_XMP_BYTES = 256 * 1024  # reject larger packets before parsing (DoS guard)
JPEG_APP1_MAX = 0xFFFF  # APP1 length field is 16-bit
PNG_HEAD_SCAN = 512 * 1024  # bounded head read for the cheap /list probe

_RATING_TO_PERCENT = {0: 0, 1: 1, 2: 25, 3: 50, 4: 75, 5: 99}
_PERCENT_BUCKETS = [(0, 0), (1, 1), (25, 2), (50, 3), (75, 4), (99, 5)]


# ---------------------------------------------------------------------------
# Rating <-> Microsoft percent
# ---------------------------------------------------------------------------


def clamp_rating(rating: object) -> int:
    """Coerce an arbitrary value to an int rating in 0..5 (0 on failure)."""
    try:
        r = int(rating)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return 0
    return max(0, min(5, r))


def rating_to_ms_percent(rating: int) -> int:
    return _RATING_TO_PERCENT[clamp_rating(rating)]


def ms_percent_to_rating(percent: int) -> int:
    """Map a 0..100 MicrosoftPhoto percent to the nearest 0..5 bucket."""
    p = max(0, min(100, int(percent)))
    return min(_PERCENT_BUCKETS, key=lambda b: abs(b[0] - p))[1]


# ---------------------------------------------------------------------------
# XMP packet build / parse
# ---------------------------------------------------------------------------


def build_xmp_packet(rating: int) -> bytes:
    """Return a complete ``<?xpacket?>``-wrapped XMP packet (UTF-8 bytes).

    The only interpolated values are validated ints, so there is no
    injection surface. ~2 KB of trailing whitespace follows the XMP per
    convention (lets other editors expand in place).
    """
    r = clamp_rating(rating)
    pct = rating_to_ms_percent(r)
    xml = (
        '<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?>\n'
        '<x:xmpmeta xmlns:x="adobe:ns:meta/">\n'
        ' <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">\n'
        '  <rdf:Description rdf:about=""\n'
        '    xmlns:xmp="http://ns.adobe.com/xap/1.0/"\n'
        '    xmlns:MicrosoftPhoto="http://ns.microsoft.com/photo/1.0/"\n'
        f'    xmp:Rating="{r}"\n'
        f'    MicrosoftPhoto:Rating="{pct}"/>\n'
        " </rdf:RDF>\n"
        "</x:xmpmeta>\n"
    )
    packet = xml + (" " * 2048) + "\n" + '<?xpacket end="w"?>'
    return packet.encode("utf-8")


def parse_rating_from_xmp(xmp_bytes: bytes | None) -> int | None:
    """Extract a 0..5 rating from an XMP packet, or None.

    Security: reject packets over ``MAX_XMP_BYTES`` and any DOCTYPE/ENTITY
    declaration (XXE / billion-laughs) before parsing.
    """
    if not xmp_bytes or len(xmp_bytes) > MAX_XMP_BYTES:
        return None
    lowered = xmp_bytes.lower()
    if b"<!doctype" in lowered or b"<!entity" in lowered:
        return None
    try:
        root = ET.fromstring(xmp_bytes)
    except ET.ParseError:
        return None
    return _find_rating(root)


def _find_rating(root: ET.Element) -> int | None:
    xmp_val: str | None = None
    ms_val: str | None = None
    xmp_attr = f"{{{NS_XMP}}}Rating"
    ms_attr = f"{{{NS_MS}}}Rating"
    for el in root.iter():
        if xmp_val is None:
            xmp_val = el.attrib.get(xmp_attr)
        if ms_val is None:
            ms_val = el.attrib.get(ms_attr)
        if xmp_val is None and el.tag == xmp_attr and el.text:
            xmp_val = el.text.strip()
        if ms_val is None and el.tag == ms_attr and el.text:
            ms_val = el.text.strip()
    if xmp_val is not None:
        try:
            return max(0, min(5, int(float(xmp_val))))
        except ValueError:
            pass
    if ms_val is not None:
        try:
            return ms_percent_to_rating(int(float(ms_val)))
        except ValueError:
            pass
    return None


# ---------------------------------------------------------------------------
# PNG iTXt surgery (lossless)
# ---------------------------------------------------------------------------


def _iter_png_chunks(data: bytes) -> Iterator[tuple[str, bytes, int, int]]:
    """Yield (type, chunk_data, start, end) for each PNG chunk.

    ``start:end`` is the full chunk slice (length + type + data + CRC).
    Raises ValueError on a bad signature or truncated chunk.
    """
    if data[:8] != PNG_SIG:
        raise ValueError("not a PNG")
    i, n = 8, len(data)
    while i + 8 <= n:
        length = int.from_bytes(data[i : i + 4], "big")
        ctype = data[i + 4 : i + 8].decode("latin-1")
        data_start = i + 8
        data_end = data_start + length
        chunk_end = data_end + 4
        if chunk_end > n:
            raise ValueError("truncated PNG chunk")
        yield ctype, data[data_start:data_end], i, chunk_end
        i = chunk_end
        if ctype == "IEND":
            break


def _make_itxt(keyword: bytes, text: bytes) -> bytes:
    # keyword \0 compflag(0) compmethod(0) lang \0 translated \0 text
    cdata = keyword + b"\x00\x00\x00\x00\x00" + text
    body = b"iTXt" + cdata
    crc = zlib.crc32(body) & 0xFFFFFFFF
    return len(cdata).to_bytes(4, "big") + body + crc.to_bytes(4, "big")


def _is_xmp_text_chunk(ctype: str, cdata: bytes) -> bool:
    return ctype in ("iTXt", "tEXt", "zTXt") and cdata.startswith(PNG_XMP_KEYWORD + b"\x00")


def _png_text_chunk_xmp(ctype: str, cdata: bytes) -> bytes | None:
    if not _is_xmp_text_chunk(ctype, cdata):
        return None
    rest = cdata[len(PNG_XMP_KEYWORD) + 1 :]
    if ctype == "tEXt":
        return rest
    if ctype == "zTXt":
        try:
            return zlib.decompress(rest[1:])  # skip compression-method byte
        except (zlib.error, IndexError):
            return None
    # iTXt: keyword \0 compflag compmethod lang \0 translated \0 text
    if len(rest) < 2:
        return None
    compflag = rest[0]
    p = len(PNG_XMP_KEYWORD) + 1 + 2  # past keyword \0, compflag, compmethod
    for _ in range(2):  # skip language tag, then translated keyword
        nl = cdata.find(b"\x00", p)
        if nl < 0:
            return None
        p = nl + 1
    text = cdata[p:]
    if compflag == 1:
        try:
            return zlib.decompress(text)
        except zlib.error:
            return None
    return text


def png_get_xmp(data: bytes) -> bytes | None:
    """Return the XMP packet from a PNG's text chunk before IDAT, or None."""
    try:
        for ctype, cdata, _s, _e in _iter_png_chunks(data):
            if ctype == "IDAT":
                break
            pkt = _png_text_chunk_xmp(ctype, cdata)
            if pkt is not None:
                return pkt
    except ValueError:
        pass
    return None


def png_set_xmp(data: bytes, xmp_packet: bytes) -> bytes:
    """Return new PNG bytes with the XMP iTXt inserted before the first
    IDAT, replacing any existing XMP text chunk. All other chunks (incl.
    ComfyUI metadata and pixels) are copied verbatim."""
    out = bytearray(PNG_SIG)
    new_chunk = _make_itxt(PNG_XMP_KEYWORD, xmp_packet)
    inserted = False
    for ctype, cdata, start, end in _iter_png_chunks(data):
        if _is_xmp_text_chunk(ctype, cdata):
            continue
        if not inserted and ctype in ("IDAT", "IEND"):
            out += new_chunk
            inserted = True
        out += data[start:end]
    if not inserted:
        out += new_chunk
    return bytes(out)


# ---------------------------------------------------------------------------
# JPEG APP1 surgery (lossless)
# ---------------------------------------------------------------------------


def _split_jpeg(data: bytes) -> tuple[list[tuple[int, bytes]], bytes]:
    """Return (segments, tail). ``segments`` is a list of (marker, bytes)
    up to the start of scan; ``tail`` is SOS..EOI raw."""
    if data[:2] != b"\xff\xd8":
        raise ValueError("not a JPEG")
    i, n = 2, len(data)
    segments: list[tuple[int, bytes]] = []
    while i + 1 < n:
        if data[i] != 0xFF:
            raise ValueError("bad JPEG marker")
        marker = data[i + 1]
        if marker == 0xD9:  # EOI
            break
        if marker == 0x01 or 0xD0 <= marker <= 0xD7:  # standalone markers
            segments.append((marker, data[i : i + 2]))
            i += 2
            continue
        if marker == 0xDA:  # SOS — scan data follows
            return segments, data[i:]
        seg_len = int.from_bytes(data[i + 2 : i + 4], "big")
        seg_end = i + 2 + seg_len
        if seg_end > n:
            raise ValueError("truncated JPEG segment")
        segments.append((marker, data[i:seg_end]))
        i = seg_end
    return segments, data[i:]


def jpeg_get_xmp(data: bytes) -> bytes | None:
    try:
        segments, _tail = _split_jpeg(data)
    except ValueError:
        return None
    for marker, seg in segments:
        if marker == 0xE1 and seg[4:].startswith(JPEG_XMP_PREFIX):
            return seg[4 + len(JPEG_XMP_PREFIX) :]
    return None


def jpeg_set_xmp(data: bytes, xmp_packet: bytes) -> bytes | None:
    """Return new JPEG bytes with the XMP APP1 inserted after SOI (after a
    leading APP0 if present), replacing any existing XMP APP1. Returns None
    if the segment would exceed the 16-bit length field — caller falls back
    to a sidecar."""
    payload = JPEG_XMP_PREFIX + xmp_packet
    seg_len = 2 + len(payload)
    if seg_len > JPEG_APP1_MAX:
        return None
    new_app1 = b"\xff\xe1" + seg_len.to_bytes(2, "big") + payload

    segments, tail = _split_jpeg(data)
    kept = [(m, s) for (m, s) in segments if not (m == 0xE1 and s[4:].startswith(JPEG_XMP_PREFIX))]
    insert_pos = 1 if kept and kept[0][0] == 0xE0 else 0

    out = bytearray(b"\xff\xd8")
    for idx, (_m, s) in enumerate(kept):
        if idx == insert_pos:
            out += new_app1
        out += s
    if insert_pos >= len(kept):
        out += new_app1
    out += tail
    return bytes(out)


# ---------------------------------------------------------------------------
# Sidecar
# ---------------------------------------------------------------------------


def sidecar_path(path: str) -> str:
    return path + ".xmp"


def sidecar_get_rating(path: str) -> int | None:
    sp = sidecar_path(path)
    try:
        if not os.path.isfile(sp) or os.path.getsize(sp) > MAX_XMP_BYTES:
            return None
        with open(sp, "rb") as f:
            data = f.read()
    except OSError:
        return None
    return parse_rating_from_xmp(data)


def sidecar_set_rating(path: str, rating: int) -> None:
    _atomic_write(sidecar_path(path), build_xmp_packet(clamp_rating(rating)))


# ---------------------------------------------------------------------------
# Atomic write
# ---------------------------------------------------------------------------


def _atomic_write(path: str, data: bytes) -> None:
    directory = os.path.dirname(path) or "."
    fd, tmp = tempfile.mkstemp(dir=directory, prefix=".glxmp_", suffix=".tmp")
    try:
        with os.fdopen(fd, "wb") as f:
            f.write(data)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, path)
    except Exception:
        with contextlib.suppress(OSError):
            os.unlink(tmp)
        raise


# ---------------------------------------------------------------------------
# Top-level read / write dispatch (+ small cache for /list)
# ---------------------------------------------------------------------------


def _read_head(path: str, limit: int | None) -> bytes:
    with open(path, "rb") as f:
        return f.read(limit) if limit else f.read()


def read_rating(path: str, *, head_only: bool = True) -> int:
    """Return 0..5 (0 = unrated). In-file XMP first, then sidecar. Never
    raises — returns 0 on any error."""
    try:
        ext = os.path.splitext(path)[1].lower()
        limit = PNG_HEAD_SCAN if head_only else None
        pkt: bytes | None = None
        if ext == ".png":
            pkt = png_get_xmp(_read_head(path, limit))
        elif ext in (".jpg", ".jpeg"):
            pkt = jpeg_get_xmp(_read_head(path, limit))
        if pkt is not None:
            r = parse_rating_from_xmp(pkt)
            if r is not None:
                return r
        sc = sidecar_get_rating(path)
        return sc if sc is not None else 0
    except Exception:
        return 0


def write_rating(path: str, rating: int) -> tuple[bool, str]:
    """Write ``rating`` (clamped 0..5). Returns (ok, backend) where backend
    is 'png' | 'jpeg' | 'sidecar', or (False, error)."""
    r = clamp_rating(rating)
    packet = build_xmp_packet(r)
    ext = os.path.splitext(path)[1].lower()
    try:
        if ext == ".png":
            with open(path, "rb") as f:
                out = png_set_xmp(f.read(), packet)
            _atomic_write(path, out)
            _cache_invalidate(path)
            return True, "png"
        if ext in (".jpg", ".jpeg"):
            with open(path, "rb") as f:
                out_opt = jpeg_set_xmp(f.read(), packet)
            if out_opt is not None:
                _atomic_write(path, out_opt)
                _cache_invalidate(path)
                return True, "jpeg"
        # Other formats, JPEG overflow → sidecar.
        sidecar_set_rating(path, r)
        _cache_invalidate(path)
        return True, "sidecar"
    except (OSError, ValueError) as exc:
        try:
            sidecar_set_rating(path, r)
            _cache_invalidate(path)
            return True, "sidecar"
        except OSError:
            return False, str(exc)


# A tiny cache keyed on (path, mtime_ns, size) so re-listing a directory
# (the common "refresh after rating") doesn't re-read every file.
_RATING_CACHE: dict[tuple[str, int, int], int] = {}
_CACHE_MAX = 5000


def read_rating_cached(path: str, st: os.stat_result) -> int:
    key = (path, st.st_mtime_ns, st.st_size)
    val = _RATING_CACHE.get(key)
    if val is not None:
        return val
    val = read_rating(path, head_only=True)
    if len(_RATING_CACHE) >= _CACHE_MAX:
        _RATING_CACHE.clear()
    _RATING_CACHE[key] = val
    return val


def _cache_invalidate(path: str) -> None:
    for key in [k for k in _RATING_CACHE if k[0] == path]:
        _RATING_CACHE.pop(key, None)
