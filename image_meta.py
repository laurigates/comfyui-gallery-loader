"""Embedded generation-metadata reader for the image browser.

PACK-LOCAL module — unlike ``xmp_meta.py`` / ``thumb_cache.py`` (vendored
verbatim from comfyui-gallery-loader) this file has no canonical home
elsewhere, so there is no ``just sync-*`` recipe and no CI drift check. Edit
it here.

Pure stdlib (``io``/``json``/``os``/``struct``/``zlib``/``collections``) — **no
PIL and no ComfyUI imports**. PIL is deliberately avoided: the pytest suite
stubs it with MagicMocks (see ``tests/conftest.py``), so a PIL call here would
silently return a Mock instead of failing loudly, making the module untestable.
Byte-level container parsing also lets us read *only* the text chunks, seeking
past the pixel data, instead of decoding an image to reach its metadata.

Two halves, deliberately separate so each is testable on its own:

1. ``read_raw_metadata(path)`` — walk the container and hand back whatever
   embedded text it carries, keyed exactly as the writer stored it
   (``prompt`` / ``workflow`` / ``parameters`` / ``UserComment`` / ``XMP`` …).
   PNG ``tEXt``/``zTXt``/``iTXt``, JPEG EXIF ``UserComment`` + ``COM`` + XMP
   APP1, WebP ``EXIF``/``XMP `` RIFF chunks, MP4/MOV ``moov/udta/meta/ilst``
   boxes (both the indexed ``keys`` form and the bare ``©cmt`` atom form), and
   Matroska/WebM ``SimpleTag`` elements. The video walks descend structurally,
   seeking past media by declared size, so a ``moov`` parked after a
   multi-megabyte ``mdat`` is reached in a handful of seeks.
2. ``parse_generation_meta(raw)`` — pure dict/JSON work over that mapping,
   mapping a ComfyUI graph or an A1111/Forge parameter block onto a small
   ``summary`` of the fields a user actually wants to copy.

Both are **defensive by contract**: a malformed, truncated or hostile
container returns whatever was recoverable and never raises to the caller —
the browser must still list and preview a file whose metadata is garbage. Both
are also **bounded** (``MAX_VALUE_BYTES`` / ``MAX_TOTAL_BYTES`` /
``MAX_TEXT_CHUNKS`` / ``MAX_WALK_CHUNKS``), because every input here is
attacker-shaped: a 1 KB ``zTXt`` can inflate to gigabytes and a lying length
field can point anywhere. Hitting any cap sets ``truncated``: "the walk gave up
here" and "the file carries nothing" must never look alike to the caller.

The guiding rule is the pack's "never fabricate data": a summary key the
container did not actually carry is **omitted**, never guessed. A wrong seed
is worse than an absent one.
"""

from __future__ import annotations

import io
import json
import logging
import os
import struct
import zlib
from collections import deque
from collections.abc import Callable, Iterator
from typing import Any

log = logging.getLogger("comfyui-image-meta")

# --- format markers ---------------------------------------------------
PNG_SIG = b"\x89PNG\r\n\x1a\n"
PNG_TEXT_CHUNKS = (b"tEXt", b"zTXt", b"iTXt")
JPEG_SOI = b"\xff\xd8"
JPEG_EXIF_PREFIX = b"Exif\x00\x00"  # APP1 EXIF marker, 6 bytes
JPEG_XMP_PREFIX = b"http://ns.adobe.com/xap/1.0/\x00"  # 29 bytes
RIFF_SIG = b"RIFF"
WEBP_SIG = b"WEBP"
EBML_SIG = b"\x1a\x45\xdf\xa3"  # Matroska/WebM magic — an EBML header element ID

# Extension -> reported container label. The label is derived from the
# extension (not from sniffed magic bytes) so it stays the single source of
# truth shared with the rest of the pack (IMG_EXTS, /thumb, the frontend's
# ext field). Each parser re-validates its own magic before reading anything,
# so a mislabelled file simply has no readable metadata rather than yielding
# garbage from the wrong parser.
#
# The video entries name the *container family*, not the extension: ``.mov``
# and ``.m4v`` are ISOBMFF exactly as ``.mp4`` is, and ``.webm`` is a Matroska
# profile. ``.avi``/``.mpg``/``.mpeg`` are deliberately absent — no ComfyUI
# writer emits them, and an entry here is what makes the ⓘ / ⤓ buttons appear,
# so listing a container we cannot read would ship two dead controls.
FORMAT_EXTS = {
    ".png": "png",
    ".jpg": "jpeg",
    ".jpeg": "jpeg",
    ".webp": "webp",
    ".mp4": "mp4",
    ".m4v": "mp4",
    ".mov": "mp4",
    ".webm": "matroska",
    ".mkv": "matroska",
}

# --- limits -----------------------------------------------------------
MAX_VALUE_BYTES = 512 * 1024  # cap on ONE metadata value
MAX_TOTAL_BYTES = 2 * 1024 * 1024  # cap on everything returned
MAX_IFD_ENTRIES = 256  # backstop on one EXIF IFD
MAX_FILL_BYTES = 1024  # backstop on one run of JPEG 0xFF fill bytes

# Two separate backstops on a container walk, because the old single
# MAX_CHUNKS=512 conflated them and was consumed by *pixel data*: PIL/ComfyUI
# emit 64 KB IDAT chunks, so a 39 MB PNG spends the whole allowance seeking past
# IDAT and never reaches a tEXt parked after the pixel data (measured: 400 IDATs
# found the prompt, 600 returned {} — and reported truncated=False, telling the
# user the file was clean when the walk had given up).
#   * MAX_TEXT_CHUNKS bounds the chunks/segments we actually *parse* — the real
#     work (read + inflate + collect), on top of the byte caps above.
#   * MAX_WALK_CHUNKS bounds header reads for chunks we only seek past. Large
#     enough that no plausible image reaches it (20k x 64 KB IDAT = 1.3 GB of
#     pixel data, and PIL's block size is that 64 KB) yet still finite, so a
#     hostile file of empty chunks cannot walk to EOF: one iteration is a
#     read(8) plus a seek, measured ~16 ms for the full 20k against 78 ms at
#     100k — this is the number to lower if that ever matters more than a
#     gigabyte-scale PNG's text chunks.
MAX_TEXT_CHUNKS = 512
MAX_WALK_CHUNKS = 20_000
# The JPEG walk keeps a small segment cap of its own: unlike PNG/RIFF, one
# iteration there can scan up to MAX_FILL_BYTES bytes one read(1) at a time, so
# 100k iterations would be 100M syscalls. Metadata always precedes SOS, which
# ends that walk anyway, so a handful of hundreds of segments is plenty.
MAX_JPEG_SEGMENTS = 512

# --- video container backstops ----------------------------------------
# A `keys` box declares its own entry count; a hostile one can declare four
# billion. Only the entries an `ilst` item can actually reference matter, and
# ffmpeg writes a handful.
MAX_MP4_KEYS = 256
# One `ilst` item name and one Matroska `TagName` are identifiers, not payload
# — a writer's longest is `creation_time`. Reading a declared-megabyte name
# would spend the value budget on a key nobody can use.
MAX_TAG_NAME_BYTES = 256
# Depth cap on the EBML descent (Segment -> Tags -> Tag -> SimpleTag is 4, and
# SimpleTag nests legally). EBML is self-describing with no structural end
# marker, so a crafted file can otherwise recurse until the interpreter's own
# stack gives out — which surfaces as a RecursionError on the event loop, not
# as the empty read this module promises.
MAX_EBML_DEPTH = 8

# Inputs that carry a prompt as a plain string. The prompt terminator is
# structural (see _text_of) rather than class-based, so this tuple is the
# whole definition of "a text-carrying node".
TEXT_INPUT_KEYS = ("text", "text_g", "text_l", "prompt", "string")

# Bounds on the link walk — hand-edited and ConditioningCombine-heavy graphs
# both cycle, and a deep chain is not worth chasing forever.
MAX_LINK_DEPTH = 24
MAX_LINK_NODES = 512


# ---------------------------------------------------------------------------
# Bounded collection
# ---------------------------------------------------------------------------


class _Collector:
    """Accumulates key -> text under the value/total caps, flagging truncation.

    Every bound in this module clamps here (plus one ``budget()`` check per
    parser, which seeks past a too-long value instead of reading it), so there
    is exactly one place to reason about how much memory a hostile file can
    make us hold.
    """

    def __init__(self) -> None:
        self.raw: dict[str, str] = {}
        self.truncated = False
        self.remaining = MAX_TOTAL_BYTES

    def budget(self) -> int:
        """Bytes worth reading for the next value."""
        return max(0, min(self.remaining, MAX_VALUE_BYTES))

    def add(self, key: str, text: str, *, clipped: bool = False) -> None:
        """Store ``text`` under ``key``, trimming to the remaining budget.

        First occurrence wins: a duplicate ``parameters`` chunk is a rewriter
        artefact, and the first one is the one every other reader sees.
        """
        if not key or not isinstance(text, str):
            return
        if clipped:
            self.truncated = True
        limit = self.budget()
        if limit <= 0:
            # Out of total budget — drop the value rather than store a stub.
            self.truncated = True
            return
        blob = text.encode("utf-8", "replace")
        if len(blob) > limit:
            # "ignore" (not "replace") so a cut mid-codepoint drops the
            # partial character instead of injecting U+FFFD.
            text = blob[:limit].decode("utf-8", "ignore")
            blob = text.encode("utf-8", "replace")
            self.truncated = True
        # Charge the budget for bytes ALREADY produced, before the duplicate
        # check drops them: what the caps exist to bound is the read+inflate
        # that materialised this string, not the dict slot it lands in.
        # Returning early on a duplicate key left ``remaining`` full, so every
        # chunk got a fresh MAX_VALUE_BYTES allowance and the guard never
        # engaged: measured 512 same-keyed zTXt chunks in a 276 KB PNG doing
        # 255 MB of inflate in 581 ms, versus 2 MB / 5 ms once charged. That is
        # request amplification, because image_browser_metadata calls
        # read_raw_metadata synchronously on the aiohttp event loop.
        self.remaining -= len(blob)
        if key in self.raw:
            return
        self.raw[key] = text


def _decode(blob: bytes) -> str:
    """Decode metadata bytes as UTF-8, falling back to Latin-1.

    PNG ``tEXt`` is Latin-1 per spec, but every ComfyUI/A1111 writer stores
    UTF-8 JSON in it — so try UTF-8 first and fall back rather than mangling
    non-ASCII prompts. Never raises: the caller is a best-effort reader.
    """
    try:
        return blob.decode("utf-8")
    except UnicodeDecodeError:
        return blob.decode("latin-1", "replace")


def _inflate(blob: bytes, limit: int) -> tuple[str | None, bool]:
    """Bounded zlib inflate. Returns (text or None on failure, clipped).

    ``decompressobj().decompress(blob, limit)`` — never ``zlib.decompress`` —
    is the zip-bomb guard: a 1 KB ``zTXt`` chunk can legally inflate to
    gigabytes, and the whole point of the caps is that no file can make us
    hold more than ``MAX_VALUE_BYTES``.
    """
    if limit <= 0:
        return None, True
    try:
        d = zlib.decompressobj()
        out = d.decompress(blob, limit)
        clipped = bool(d.unconsumed_tail or d.unused_data)
    except zlib.error as exc:
        # Bad stream — omit this key but keep whatever the other chunks hold.
        log.debug("zTXt/iTXt inflate failed: %s", exc)
        return None, False
    return _decode(out), clipped


def _stream_size(f: io.BufferedReader) -> int:
    """Byte length of the open file, from one seek pair, position preserved.

    Every container here declares each chunk's length up front, and with CRCs
    deliberately unverified (see _png_text_chunk) that length is the *only*
    framing signal there is. So all three walks check it against this: a chunk
    that claims more bytes than the file holds is not a chunk header we found,
    it is bytes that happen to sit where one would be — decoding what follows
    would invent a key/value the writer never wrote. Deliberately not
    ``os.fstat(f.fileno())``, so any seekable stream works.
    """
    here = f.tell()
    f.seek(0, io.SEEK_END)
    size = f.tell()
    f.seek(here)
    return size


# ---------------------------------------------------------------------------
# Public entry — container walk
# ---------------------------------------------------------------------------


def read_raw_metadata(path: str) -> tuple[dict[str, str], bool]:
    """Extract embedded text metadata. Returns (raw, truncated). Never raises.

    ``raw`` maps the writer's own keys to their text; ``truncated`` is True
    when a cap trimmed or dropped something. An extension with no parser (a
    ``.gif``/``.tif`` from IMG_EXTS) returns ``({}, False)`` — an honest "no
    metadata read", not an error.
    """
    c = _Collector()
    fmt = FORMAT_EXTS.get(os.path.splitext(path)[1].lower(), "")
    if not fmt:
        return c.raw, c.truncated
    try:
        # Opened once, read by seek/short-read only — never f.read() of the
        # whole file, which for a 30 MB PNG would be all pixels and no text.
        with open(path, "rb") as f:
            if fmt == "png":
                _read_png(f, c)
            elif fmt == "jpeg":
                _read_jpeg(f, c)
            elif fmt == "mp4":
                _read_isobmff(f, c)
            elif fmt == "matroska":
                _read_matroska(f, c)
            else:
                _read_webp(f, c)
            if fmt in ("mp4", "matroska"):
                _unwrap_comment_envelope(c)
    except Exception as exc:
        # Best-effort read, same posture as xmp_meta.read_rating: a corrupt
        # container degrades to "whatever we got", but log so it's diagnosable.
        log.debug("metadata read failed for %s: %s", path, exc)
    return c.raw, c.truncated


# ---------------------------------------------------------------------------
# PNG — chunk walk (all lengths big-endian)
# ---------------------------------------------------------------------------


def _read_png(f: io.BufferedReader, c: _Collector) -> None:
    """Collect every tEXt/zTXt/iTXt keyword -> text pair in a PNG.

    The two caps are deliberately different quantities (see MAX_TEXT_CHUNKS):
    text chunks are parsed, everything else is a seek, and giving up on either
    bound sets ``truncated`` — a walk that stopped early must never be reported
    as "this file carries no metadata".
    """
    if f.read(8) != PNG_SIG:
        return
    size = _stream_size(f)
    texts = 0
    for _ in range(MAX_WALK_CHUNKS):
        hdr = f.read(8)
        if len(hdr) < 8:
            return
        length = int.from_bytes(hdr[:4], "big")
        ctype = hdr[4:8]
        if f.tell() + length > size:
            # The declared length does not fit in the file (_stream_size): the
            # walk has lost the framing, so stop rather than decode the tail as
            # a keyword/text pair. Only the *data* has to fit — a file cut off
            # right after a complete chunk still yields that chunk, and the CRC
            # seek below simply overshoots into the short read that ends us.
            return
        if ctype in PNG_TEXT_CHUNKS:
            texts += 1
            if texts > MAX_TEXT_CHUNKS:
                c.truncated = True
                return
            n = min(length, c.budget())
            cdata = f.read(n)
            clipped = len(cdata) < length
            if clipped:
                c.truncated = True
            # +4 skips the CRC. CRCs are deliberately NOT verified — this is a
            # reader, and a bad checksum must not hide recoverable metadata.
            f.seek(length - len(cdata) + 4, io.SEEK_CUR)
            _png_text_chunk(ctype, cdata, clipped, c)
        else:
            f.seek(length + 4, io.SEEK_CUR)
        if ctype == b"IEND":
            return
    # Fell out of the loop: the backstop stopped us short of IEND, so anything
    # beyond here is unread rather than absent.
    c.truncated = True


def _png_text_chunk(ctype: bytes, cdata: bytes, clipped: bool, c: _Collector) -> None:
    """Parse one PNG text chunk's payload into the collector.

    Unlike ``xmp_meta.png_get_xmp`` (which breaks at IDAT for its cheap /list
    probe) the caller walks all the way to IEND: IDAT is skipped with a seek,
    so reaching the end costs a handful of syscalls even on a 30 MB file, and
    some rewriters park their text chunks *after* the pixel data.
    """
    nul = cdata.find(b"\x00")
    if nul <= 0:
        return
    key = _decode(cdata[:nul])
    rest = cdata[nul + 1 :]
    if ctype == b"tEXt":
        c.add(key, _decode(rest), clipped=clipped)
        return
    if ctype == b"zTXt":
        # keyword \0 compmethod(1) zlib-stream
        text, inflate_clipped = _inflate(rest[1:], c.budget())
        if text is not None:
            c.add(key, text, clipped=clipped or inflate_clipped)
        return
    # iTXt: keyword \0 compflag(1) compmethod(1) lang \0 translated \0 text —
    # the same offset dance as xmp_meta._png_text_chunk_xmp.
    if len(rest) < 2:
        return
    compflag = rest[0]
    p = 2  # past compflag + compmethod
    for _ in range(2):  # skip the language tag, then the translated keyword
        nl = rest.find(b"\x00", p)
        if nl < 0:
            return
        p = nl + 1
    if compflag == 1:
        text, inflate_clipped = _inflate(rest[p:], c.budget())
        if text is not None:
            c.add(key, text, clipped=clipped or inflate_clipped)
        return
    c.add(key, _decode(rest[p:]), clipped=clipped)


# ---------------------------------------------------------------------------
# JPEG — segment walk (all lengths big-endian)
# ---------------------------------------------------------------------------


def _read_jpeg(f: io.BufferedReader, c: _Collector) -> None:
    """Collect APP1 EXIF UserComment / APP1 XMP / COM comment from a JPEG.

    Seek-based and non-raising, mirroring ``xmp_meta._split_jpeg`` but without
    its ValueErrors — a reader has to survive the files a writer wouldn't emit.
    """
    if f.read(2) != JPEG_SOI:
        return
    size = _stream_size(f)
    for _ in range(MAX_JPEG_SEGMENTS):
        b = f.read(1)
        if b != b"\xff":
            # Not at a marker boundary (or EOF) — stop rather than guess where
            # the next segment starts.
            return
        # A run of 0xFF fill bytes before a marker is legal, but the run is
        # *inside* one segment, so the segment cap does not bound it: an all-0xFF
        # file used to be walked to EOF one read(1) at a time (measured 3.9 s
        # for 64 MiB, ~1 min/GiB) while returning nothing. A real run is one or
        # two bytes; past MAX_FILL_BYTES the stream is not a JPEG we can frame.
        for _ in range(MAX_FILL_BYTES):
            b = f.read(1)
            if b != b"\xff":
                break
        else:
            return
        if not b:
            return
        marker = b[0]
        if marker in (0xD9, 0xDA):
            # EOI / SOS. Metadata always precedes the scan, and chasing APP
            # segments past SOS would mean reading the whole compressed image.
            return
        if marker == 0x00 or marker == 0x01 or 0xD0 <= marker <= 0xD7:
            continue  # standalone markers carry no length field
        raw_len = f.read(2)
        if len(raw_len) < 2:
            return
        payload = int.from_bytes(raw_len, "big") - 2
        if payload < 0 or f.tell() + payload > size:
            # Length below its own 2 bytes, or a segment that runs past EOF —
            # mis-framed either way, so stop instead of reporting the tail as a
            # comment/XMP value (same posture as the PNG walk).
            return
        if marker == 0xE1:  # APP1 — EXIF or XMP
            # Always read at least the 29-byte XMP prefix (plus the TIFF
            # header) so the segment is identifiable even at zero budget.
            want = min(payload, max(c.budget(), len(JPEG_XMP_PREFIX) + 8))
            buf = f.read(want)
            f.seek(payload - len(buf), io.SEEK_CUR)
            if buf.startswith(JPEG_EXIF_PREFIX):
                _exif_tags(buf[len(JPEG_EXIF_PREFIX) :], c)
            elif buf.startswith(JPEG_XMP_PREFIX):
                xmp = buf[len(JPEG_XMP_PREFIX) :]
                c.add("XMP", _decode(xmp), clipped=len(buf) < payload)
        elif marker == 0xFE:  # COM
            buf = f.read(min(payload, c.budget()))
            f.seek(payload - len(buf), io.SEEK_CUR)
            c.add("Comment", _decode(buf), clipped=len(buf) < payload)
        else:
            f.seek(payload, io.SEEK_CUR)
    c.truncated = True  # backstop hit before SOS/EOI — see _read_png


# EXIF value type -> bytes per component. Unknown types fall back to 1, which
# only ever over-reads within the already bounds-checked block.
_EXIF_TYPE_SIZES = {1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1, 9: 4, 10: 8, 11: 4, 12: 8}


def _ifd_entries(tiff: bytes, offset: int, order: str) -> dict[int, tuple[int, int, bytes]]:
    """Parse one IFD to {tag: (type, count, 4-byte value/offset field)}.

    IFD layout: a 2-byte entry count, ``count`` x 12-byte entries
    ``(tag:2, type:2, n:4, value_or_offset:4)``, then a 4-byte next-IFD
    offset. Every offset is bounds-checked against ``tiff`` before slicing —
    the offsets are attacker-controlled and routinely point past the end in
    truncated files.
    """
    out: dict[int, tuple[int, int, bytes]] = {}
    if offset < 8 or offset + 2 > len(tiff):
        return out
    count = struct.unpack(order + "H", tiff[offset : offset + 2])[0]
    p = offset + 2
    for _ in range(min(count, MAX_IFD_ENTRIES)):
        if p + 12 > len(tiff):
            break
        tag, typ, n = struct.unpack(order + "HHI", tiff[p : p + 8])
        out[tag] = (typ, n, tiff[p + 8 : p + 12])
        p += 12
    return out


def _exif_bytes(tiff: bytes, entry: tuple[int, int, bytes] | None, order: str) -> bytes | None:
    """Return one IFD entry's raw value bytes (inline or via its offset)."""
    if entry is None:
        return None
    typ, count, field = entry
    size = _EXIF_TYPE_SIZES.get(typ, 1) * count
    if size <= 0:
        return None
    if size <= 4:
        # A value of 4 bytes or fewer sits inline in the offset field itself.
        return field[:size]
    start = struct.unpack(order + "I", field)[0]
    if start < 8 or start + size > len(tiff):
        return None
    return tiff[start : start + size]


# IFD0 string tags worth reading, tag -> the key they are reported under.
# 0x010E ImageDescription is where some Forge builds put the A1111 block.
# 0x010F/0x0110 are Make/Model, which is where ComfyUI core's SaveAnimatedWEBP
# parks the graph: a WebP has no PNG text chunk to write into, so it stashes
# ``"prompt:{json}"`` in 0x0110 and then walks *down* from 0x010F for each
# extra_pnginfo key (``"workflow:{json}"``). Read only these three — the rest of
# IFD0 is camera plumbing, and a summary must never come from a guessed tag.
_EXIF_STRING_TAGS = ((0x010E, "ImageDescription"), (0x010F, "Make"), (0x0110, "Model"))

# The pnginfo keys SaveAnimatedWEBP prefixes onto its JSON ("<key>:<json>").
# Splitting the prefix back off restores exactly the raw keys a PNG writer would
# have used, so parse_generation_meta needs no per-container knowledge.
_EXIF_GRAPH_PREFIXES = ("prompt", "workflow")


def _add_exif_string(c: _Collector, label: str, blob: bytes) -> None:
    """Store one IFD0 string tag, un-prefixing an embedded ComfyUI graph.

    The ``{`` check is what keeps a real camera's ``Model`` (or a caption that
    happens to contain a colon) out of the graph keys: only a prefix followed
    by a JSON object is treated as the writer's stashed graph.
    """
    text = _decode(blob).strip("\x00")
    if not text:
        return
    for name in _EXIF_GRAPH_PREFIXES:
        head = name + ":"
        if text.startswith(head) and text[len(head) :].lstrip().startswith("{"):
            c.add(name, text[len(head) :])
            return
    c.add(label, text)


def _exif_tags(tiff: bytes, c: _Collector) -> None:
    """Read UserComment (and the IFD0 string tags) out of a TIFF/EXIF block."""
    if len(tiff) < 8:
        return
    if tiff[:2] == b"II":
        order = "<"
    elif tiff[:2] == b"MM":
        order = ">"
    else:
        return
    if struct.unpack(order + "H", tiff[2:4])[0] != 42:
        return  # not a TIFF header — 42 is the magic every EXIF block carries
    ifd0_offset = struct.unpack(order + "I", tiff[4:8])[0]
    ifd0 = _ifd_entries(tiff, ifd0_offset, order)

    for tag, label in _EXIF_STRING_TAGS:
        blob = _exif_bytes(tiff, ifd0.get(tag), order)
        if blob:
            _add_exif_string(c, label, blob)

    # 0x8769 ExifIFDPointer -> the sub-IFD that actually holds UserComment.
    ptr = _exif_bytes(tiff, ifd0.get(0x8769), order)
    if not ptr or len(ptr) < 4:
        return
    sub = _ifd_entries(tiff, struct.unpack(order + "I", ptr[:4])[0], order)
    # 0x9286 UserComment — type 7 (UNDEFINED), count = byte length.
    blob = _exif_bytes(tiff, sub.get(0x9286), order)
    if blob:
        c.add("UserComment", _decode_user_comment(blob, order))


def _decode_user_comment(blob: bytes, order: str) -> str:
    """Decode an EXIF UserComment payload past its 8-byte charset prefix."""
    prefix, rest = blob[:8], blob[8:]
    if prefix == b"ASCII\x00\x00\x00":
        return _decode(rest).strip("\x00")
    if prefix == b"UNICODE\x00":
        # Endianness follows the TIFF byte order, but an explicit BOM wins —
        # writers disagree, and the BOM is the only in-band statement of fact.
        if rest[:2] == b"\xff\xfe":
            enc, rest = "utf-16-le", rest[2:]
        elif rest[:2] == b"\xfe\xff":
            enc, rest = "utf-16-be", rest[2:]
        else:
            enc = "utf-16-le" if order == "<" else "utf-16-be"
        return rest.decode(enc, "replace").strip("\x00")
    if prefix.startswith(b"JIS"):
        # No JIS codec path is shipped; a JIS comment is never a prompt block.
        return ""
    if prefix == b"\x00" * 8:
        return _decode(rest).strip("\x00")
    # Prefix-less blob — A1111-era writers emit both the correct UNICODE form
    # and a bare string, so treat the whole payload as text.
    return _decode(blob).strip("\x00")


# ---------------------------------------------------------------------------
# WebP — RIFF chunk walk (everything little-endian here, unlike PNG/JPEG)
# ---------------------------------------------------------------------------


def _read_webp(f: io.BufferedReader, c: _Collector) -> None:
    """Collect the EXIF / XMP RIFF chunks out of a WebP file."""
    head = f.read(12)
    if len(head) < 12 or head[0:4] != RIFF_SIG or head[8:12] != WEBP_SIG:
        return
    # The RIFF size field routinely over-declares (and is attacker-controlled),
    # so the walk is clamped to whichever end comes first, the declared one or
    # the real one.
    end = min(8 + int.from_bytes(head[4:8], "little"), _stream_size(f))
    pos = 12
    metas = 0
    # Same split as the PNG walk, and for the same reason: an extended WebP puts
    # EXIF/XMP *last*, after every ANMF frame chunk, so a single 512-chunk cap
    # would be eaten by the frames of a long SaveAnimatedWEBP and silently drop
    # the graph the file really carries.
    for _ in range(MAX_WALK_CHUNKS):
        if pos + 8 > end:
            return
        f.seek(pos)
        hdr = f.read(8)
        if len(hdr) < 8:
            return  # the file shrank under us (a browser deletes/rewrites too)
        fourcc = hdr[0:4]
        size = int.from_bytes(hdr[4:8], "little")
        if pos + 8 + size > end:
            return  # payload runs past the container end — mis-framed, stop
        # RIFF payloads are padded to an even length; forgetting the pad byte
        # is the classic way to lose every chunk after an odd-sized one.
        pos += 8 + size + (size & 1)
        if fourcc in (b"EXIF", b"XMP "):
            metas += 1
            if metas > MAX_TEXT_CHUNKS:
                c.truncated = True
                return
        if fourcc == b"EXIF":
            buf = f.read(min(size, c.budget()))
            # Both the bare TIFF block and a JPEG-style "Exif\0\0"-prefixed
            # one are in the wild.
            if buf.startswith(JPEG_EXIF_PREFIX):
                buf = buf[len(JPEG_EXIF_PREFIX) :]
            _exif_tags(buf, c)
        elif fourcc == b"XMP ":  # note the trailing space — FourCCs are 4 bytes
            buf = f.read(min(size, c.budget()))
            c.add("XMP", _decode(buf), clipped=len(buf) < size)
    c.truncated = True  # backstop hit before the container end — see _read_png


# ---------------------------------------------------------------------------
# MP4 / MOV — ISOBMFF box walk (all lengths big-endian)
# ---------------------------------------------------------------------------
#
# Layout, verified by dumping the box tree of real outputs on the GPU box
# rather than from the spec, because the two writers differ structurally:
#
#   moov -> udta -> meta -> [keys] + ilst
#
# * Core ``SaveVideo`` (PyAV/ffmpeg mdta path) writes a ``keys`` box mapping
#   1-based indices to names (``prompt``, ``workflow``, …) and an ``ilst``
#   whose items are typed by that index (``\x00\x00\x00\x01``).
# * kijai's ``WanVideoWrapper.save_video`` writes **no ``keys`` box at all** —
#   its ``ilst`` items are classic iTunes fourcc atoms (``©cmt``), holding the
#   double-encoded ``{"prompt": …, "workflow": …}`` envelope unwrapped below.
#
# Both forms are read here. ComfyUI's own frontend parser handles only the
# first (it returns early when the ``keys`` box is missing), which is why the
# ⤓ button hands videos to `app.loadGraphData` with the graph this module
# parsed instead of letting `handleFile` re-read the container — see
# browser.ts's loadWorkflow.
#
# ``moov`` sits AFTER a multi-megabyte ``mdat`` in most of these files, so the
# walk seeks by declared box size rather than scanning a prefix: the metadata
# is reached in a handful of seeks no matter how large the video is.

# ilst fourcc atoms worth naming. The leading byte is 0xA9 — MacRoman "©" —
# and ffmpeg maps these onto the same metadata keys it exposes by name.
ILST_ATOM_NAMES = {
    b"\xa9cmt": "comment",
    b"\xa9nam": "title",
    b"\xa9des": "description",
    b"desc": "description",
    b"\xa9ART": "artist",
    b"\xa9too": "encoder",
    b"\xa9swr": "encoder",
}


def _iter_boxes(f: io.BufferedReader, start: int, end: int) -> Iterator[tuple[bytes, int, int]]:
    """Yield ``(type, body_start, box_end)`` for each box in ``[start, end)``.

    Skips each box by its declared size, so a payload is only ever read when a
    caller asks for it. A size that runs past ``end`` stops the walk: as in the
    PNG/RIFF walks, a length that does not fit means these are not box headers
    we found but bytes that happen to look like some.
    """
    pos = start
    for _ in range(MAX_WALK_CHUNKS):
        if pos + 8 > end:
            return
        f.seek(pos)
        hdr = f.read(8)
        if len(hdr) < 8:
            return  # the file shrank under us
        size = int.from_bytes(hdr[0:4], "big")
        btype = hdr[4:8]
        head = 8
        if size == 1:
            # 64-bit largesize, for a box above 4 GiB.
            ext = f.read(8)
            if len(ext) < 8:
                return
            size = int.from_bytes(ext, "big")
            head = 16
        elif size == 0:
            size = end - pos  # "extends to the end of the container"
        if size < head or pos + size > end:
            return
        yield btype, pos + head, pos + size
        pos += size


def _find_box(f: io.BufferedReader, start: int, end: int, btype: bytes) -> tuple[int, int] | None:
    """First ``btype`` box directly inside ``[start, end)``, as (body, end)."""
    for found, bstart, bend in _iter_boxes(f, start, end):
        if found == btype:
            return bstart, bend
    return None


def _parse_keys_box(f: io.BufferedReader, start: int, end: int) -> dict[int, str]:
    """The ``keys`` box's 1-based index -> name map (empty when unreadable)."""
    f.seek(start)
    head = f.read(8)  # version/flags (4) + entry_count (4)
    if len(head) < 8:
        return {}
    count = min(int.from_bytes(head[4:8], "big"), MAX_MP4_KEYS)
    out: dict[int, str] = {}
    pos = start + 8
    for index in range(1, count + 1):
        if pos + 8 > end:
            break
        f.seek(pos)
        entry = f.read(8)  # size (4) + namespace (4, e.g. "mdta")
        if len(entry) < 8:
            break
        size = int.from_bytes(entry[0:4], "big")
        if size < 8 or pos + size > end:
            break
        name = _decode(f.read(min(size - 8, MAX_TAG_NAME_BYTES))).strip()
        if name:
            out[index] = name
        pos += size
    return out


def _ilst_item_name(btype: bytes, keys: dict[int, str]) -> str | None:
    """Resolve an ``ilst`` item's type to a metadata key name.

    Two disjoint schemes, discriminated by the type bytes themselves: a small
    integer indexes the ``keys`` box, anything else is a fourcc atom. They
    cannot collide — an index is bounded by MAX_MP4_KEYS while a printable
    fourcc is at least 0x20202020.
    """
    index = int.from_bytes(btype, "big")
    if index in keys:
        return keys[index]
    named = ILST_ATOM_NAMES.get(btype)
    if named:
        return named
    # An unrecognised atom still belongs in the raw view — but only if its name
    # is actually printable. Anything else is a binary type we would be
    # inventing a name for.
    text = btype.lstrip(b"\xa9").decode("latin-1", "replace").strip()
    if text and all(32 <= ord(ch) <= 126 for ch in text):
        return text
    return None


def _read_isobmff(f: io.BufferedReader, c: _Collector) -> None:
    """Collect ``moov/udta/meta/ilst`` metadata out of an MP4/MOV file."""
    end = _stream_size(f)
    # `ftyp` need not be first in theory, but every writer puts it there, and
    # requiring it keeps a mislabelled file from being walked as boxes.
    f.seek(0)
    if f.read(8)[4:8] != b"ftyp":
        return
    udta = None
    moov = _find_box(f, 0, end, b"moov")
    if moov:
        udta = _find_box(f, moov[0], moov[1], b"udta")
    if not udta:
        udta = _find_box(f, 0, end, b"udta")  # some muxers hoist it
    if not udta:
        return
    meta = _find_box(f, udta[0], udta[1], b"meta")
    if not meta:
        return
    # `meta` is a FullBox (4 bytes of version/flags before its children) in
    # every ffmpeg-written file, but QuickTime writes it as a plain box. Try
    # the fullbox reading first and fall back, rather than guessing: a wrong
    # offset by 4 makes the whole box tree unparseable, which would look
    # exactly like "this file has no metadata".
    for skip in (4, 0):
        ilst = _find_box(f, meta[0] + skip, meta[1], b"ilst")
        if ilst:
            keys_box = _find_box(f, meta[0] + skip, meta[1], b"keys")
            keys = _parse_keys_box(f, *keys_box) if keys_box else {}
            _read_ilst(f, ilst[0], ilst[1], keys, c)
            return


def _read_ilst(
    f: io.BufferedReader, start: int, end: int, keys: dict[int, str], c: _Collector
) -> None:
    """Collect each ``ilst`` item's ``data`` payload under its resolved name."""
    items = 0
    for btype, bstart, bend in _iter_boxes(f, start, end):
        items += 1
        if items > MAX_TEXT_CHUNKS:
            c.truncated = True
            return
        name = _ilst_item_name(btype, keys)
        if not name:
            continue
        data = _find_box(f, bstart, bend, b"data")
        if not data:
            continue
        # data box body: type indicator (4) + locale (4) + the value.
        vstart = data[0] + 8
        if vstart >= data[1]:
            continue
        f.seek(vstart)
        want = data[1] - vstart
        buf = f.read(min(want, c.budget()))
        # Lowercased for the same reason ComfyUI's own mp4/webm parsers
        # lowercase: the case is a container convention (Matroska tag names are
        # conventionally upper), not something the writer chose, and the graph
        # lookup downstream keys on `prompt`/`workflow`.
        c.add(name.lower(), _decode(buf), clipped=len(buf) < want)


# ---------------------------------------------------------------------------
# WebM / MKV — EBML element walk
# ---------------------------------------------------------------------------
#
# Segment -> Tags -> Tag -> SimpleTag -> {TagName, TagString}. Core ComfyUI
# writes ``WORKFLOW``/``PROMPT`` tags; kijai/MMAudio write a single
# ``COMMENT`` holding the same envelope the MP4 side unwraps.
#
# Like the ISOBMFF walk this descends structurally, skipping each Cluster by
# its declared size — so tags written after the media data are still found,
# which a bounded prefix scan (what the frontend does) would miss.

EBML_ID_SEGMENT = 0x18538067
EBML_ID_TAGS = 0x1254C367
EBML_ID_TAG = 0x7373
EBML_ID_SIMPLE_TAG = 0x67C8
EBML_ID_TAG_NAME = 0x45A3
EBML_ID_TAG_STRING = 0x4487


def _read_vint(f: io.BufferedReader, keep_marker: bool) -> tuple[int | None, int]:
    """Read one EBML variable-length integer. Returns (value, bytes consumed).

    Element **IDs** keep their length-marker bits (that is what makes
    ``0x1254C367`` the literal Tags ID); element **sizes** have them stripped.
    A size whose data bits are all ones means "unknown length", reported here
    as ``None`` — legal for a Segment in a streamed file.
    """
    first = f.read(1)
    if not first:
        return None, 0
    byte = first[0]
    if byte == 0:
        return None, 0  # no marker bit in the first byte: not a valid vint
    length = 1
    mask = 0x80
    while not byte & mask:
        mask >>= 1
        length += 1
    rest = f.read(length - 1)
    if len(rest) < length - 1:
        return None, 0
    if keep_marker:
        return int.from_bytes(first + rest, "big"), length
    value = byte & (0xFF >> length)
    for b in rest:
        value = (value << 8) | b
    if value == (1 << (7 * length)) - 1:
        return None, length  # unknown-size element
    return value, length


def _ebml_children(f: io.BufferedReader, start: int, end: int) -> Iterator[tuple[int, int, int]]:
    """Yield ``(id, body_start, body_end)`` for each element in ``[start, end)``."""
    pos = start
    for _ in range(MAX_WALK_CHUNKS):
        if pos >= end:
            return
        f.seek(pos)
        elem_id, id_len = _read_vint(f, True)
        if elem_id is None:
            return
        size, size_len = _read_vint(f, False)
        if size_len == 0:
            return
        body = pos + id_len + size_len
        if size is None:
            # Unknown length — the element runs to the end of its parent. It
            # cannot be skipped, so this is necessarily the last one here.
            yield elem_id, body, end
            return
        if size < 0 or body + size > end:
            return
        yield elem_id, body, body + size
        pos = body + size


def _read_matroska(f: io.BufferedReader, c: _Collector) -> None:
    """Collect the SimpleTag name/value pairs out of a WebM/MKV file."""
    f.seek(0)
    if f.read(4) != EBML_SIG:
        return
    end = _stream_size(f)
    for elem_id, start, stop in _ebml_children(f, 0, end):
        if elem_id != EBML_ID_SEGMENT:
            continue
        for seg_id, tstart, tstop in _ebml_children(f, start, stop):
            # Not `return` on the first Tags element: Matroska permits several,
            # and ffmpeg writes a second one when tags are added after muxing.
            if seg_id == EBML_ID_TAGS:
                _read_ebml_tags(f, tstart, tstop, c, 0)


def _read_ebml_tags(f: io.BufferedReader, start: int, end: int, c: _Collector, depth: int) -> None:
    """Walk Tag/SimpleTag elements, collecting each TagName -> TagString."""
    if depth > MAX_EBML_DEPTH:
        c.truncated = True
        return
    for elem_id, estart, eend in _ebml_children(f, start, end):
        if elem_id == EBML_ID_TAG:
            _read_ebml_tags(f, estart, eend, c, depth + 1)
        elif elem_id == EBML_ID_SIMPLE_TAG:
            _read_simple_tag(f, estart, eend, c, depth)


def _read_simple_tag(
    f: io.BufferedReader, start: int, end: int, c: _Collector, depth: int
) -> None:
    """Collect one SimpleTag's name/value, recursing into any nested tags.

    The depth guard is repeated here, not just in ``_read_ebml_tags``: a
    SimpleTag nests *directly* inside a SimpleTag, so a chain of them never
    passes back through that function and would recurse once per level with
    nothing stopping it. Caught by the 200-deep regression test, which read the
    innermost value happily before this check existed.
    """
    if depth > MAX_EBML_DEPTH:
        c.truncated = True
        return
    name: str | None = None
    value: str | None = None
    clipped = False
    for elem_id, estart, eend in _ebml_children(f, start, end):
        if elem_id == EBML_ID_TAG_NAME:
            f.seek(estart)
            name = _decode(f.read(min(eend - estart, MAX_TAG_NAME_BYTES))).strip("\x00 ")
        elif elem_id == EBML_ID_TAG_STRING:
            f.seek(estart)
            want = eend - estart
            buf = f.read(min(want, c.budget()))
            value = _decode(buf).rstrip("\x00")
            clipped = len(buf) < want
        elif elem_id == EBML_ID_SIMPLE_TAG:
            # A nested SimpleTag qualifies its parent (per-language variants).
            # Recurse into the CHILD's range — passing the parent's would
            # re-walk this same element until the depth cap fired.
            _read_simple_tag(f, estart, eend, c, depth + 1)
    if name and value is not None:
        c.add(name.lower(), value, clipped=clipped)


# ---------------------------------------------------------------------------
# The kijai `comment` envelope
# ---------------------------------------------------------------------------


def _unwrap_comment_envelope(c: _Collector) -> None:
    """Promote a ``{"prompt": …, "workflow": …}`` comment to top-level keys.

    kijai's video writers park both graphs inside a single ``comment`` tag as
    *double-encoded* JSON — an object whose two values are themselves JSON
    strings. Left wrapped, the graph is invisible to everything downstream:
    ``parse_generation_meta`` looks for a graph *at* a GRAPH_KEYS slot, and the
    frontend's workflow gate reads ``raw.workflow``/``raw.prompt``. 26% of the
    videos on the reference install are written this way, so this is the
    difference between the ⓘ card working for three quarters of a library and
    all of it.

    The envelope is kept alongside the unwrapped keys rather than replaced:
    ``comment`` is genuinely what the writer stored, and the raw view is a
    verbatim report. Only a *string* value is promoted as-is; an already-parsed
    object is re-serialised, because the graph parsers take text.
    """
    text = c.raw.get("comment")
    if not text:
        return
    try:
        envelope = json.loads(text)
    except (ValueError, TypeError):
        return  # a plain human comment — nothing to unwrap, not an error
    if not isinstance(envelope, dict):
        return
    for key in ("prompt", "workflow"):
        if key in c.raw:
            continue  # a native tag already carries it; never override
        value = envelope.get(key)
        if isinstance(value, str):
            c.add(key, value)
        elif isinstance(value, (dict, list)):
            try:
                c.add(key, json.dumps(value))
            except (TypeError, ValueError):
                continue


# ---------------------------------------------------------------------------
# Public entry — generation-metadata summary
# ---------------------------------------------------------------------------

SAMPLER_CLASSES = {"KSampler", "KSamplerAdvanced", "SamplerCustom", "SamplerCustomAdvanced"}

# Widget names that make a *Sampler*-named node a plausible sampler. A bare
# KSamplerSelect only holds sampler_name and must not outrank the real one.
SAMPLER_WIDGETS = ("seed", "noise_seed", "steps", "cfg")

# summary key -> (widget names on the sampler itself, link inputs to chase
# when the widget lives elsewhere). SamplerCustomAdvanced splits the classic
# KSampler widgets across satellite nodes: sampler_name onto KSamplerSelect
# (via `sampler`), steps/scheduler onto BasicScheduler (via `sigmas`), cfg
# onto CFGGuider (via `guider`), the seed onto a noise node.
SUMMARY_WIDGETS: tuple[tuple[str, tuple[str, ...], tuple[str, ...]], ...] = (
    ("seed", ("seed", "noise_seed"), ("noise",)),
    ("steps", ("steps",), ("sigmas",)),
    ("cfg", ("cfg", "cfg_scale"), ("guider",)),
    ("sampler", ("sampler_name",), ("sampler",)),
    ("scheduler", ("scheduler",), ("sigmas",)),
)

# Checkpoint/UNet loader widgets, in preference order when one node holds
# several.
# Checkpoint/UNet loader widgets, in preference order when one node holds
# several. ``model`` is last and is deliberately the loosest: it is the key
# ``WanVideoModelLoader`` (and the MMAudio loaders) use for the filename, but
# it is also the name of the MODEL *link* every sampler carries. Only
# ``_scalar`` decides between them — it rejects a ``[node_id, slot]`` list — so
# a link can never be reported as a model name. Keeping it last means a graph
# with a real ``ckpt_name``/``unet_name`` still prefers that.
MODEL_KEYS = ("ckpt_name", "unet_name", "model_name", "model_path", "model")

# Raw keys that can hold a Comfy graph. ``prompt``/``workflow`` are the PNG text
# chunks ComfyUI core writes, but they are the *only* place a PNG writer has —
# JPEG and WebP have no text chunk, so their writers park the same JSON in EXIF
# UserComment, the JPEG COM segment or ImageDescription. Dispatching on
# ``prompt``/``workflow`` alone made Comfy-graph detection structurally
# PNG-only: a JPEG carrying a complete graph in UserComment reported
# ``source="none"`` while _from_api_graph handled that identical text fine.
GRAPH_KEYS = ("prompt", "workflow", "UserComment", "Comment", "ImageDescription", "Description")


def parse_generation_meta(raw: dict[str, str]) -> tuple[str, dict[str, str]]:
    """Return (source, summary). Pure dict/JSON work — no disk, never raises.

    ``source`` is ``"comfyui"``, ``"a1111"`` or ``"none"``. A parsed Comfy
    graph reports ``"comfyui"`` even when the summary comes out empty: the
    container really did carry a Comfy graph, and omitting the keys we could
    not resolve is the honest report.

    The API graph is tried across **every** GRAPH_KEYS slot before the UI graph
    is tried across any of them: which key a writer chose is an accident of the
    container, whereas API-vs-UI is a real difference in how much can be read
    honestly (the API form has named inputs, so it yields the numbers too).
    A1111 comes last — its marker check is loose enough that a graph must get
    first refusal.
    """
    try:
        if not isinstance(raw, dict):
            return "none", {}
        for parse in (_from_api_graph, _from_ui_graph):
            for key in GRAPH_KEYS:
                source, summary = parse(raw.get(key))
                if source:
                    return source, summary
        source, summary = _from_a1111(raw)
        if source:
            return source, summary
    except Exception as exc:
        # Same best-effort posture as the container walk: an unexpected shape
        # yields "unknown", never a 500 on the endpoint.
        log.debug("generation metadata parse failed: %s", exc)
    return "none", {}


def _scalar(value: Any) -> str | None:
    """Stringify a widget value, or None when it isn't a value at all.

    A list is a ``[node_id, slot]`` link, not data — stringifying one would
    report a seed of ``"[9, 0]"``, i.e. fabricate. Booleans are widget
    toggles (``add_noise``, ``enable``) and never belong in the summary.
    """
    if isinstance(value, str):
        return value
    if isinstance(value, bool):
        return None
    if isinstance(value, int | float):
        return str(value)
    return None


def _is_link(value: Any) -> bool:
    """True for a ``[node_id, slot]`` input reference."""
    return isinstance(value, list | tuple) and len(value) >= 1


def _text_of(inputs: dict[str, Any]) -> str | None:
    """Return a node's prompt text, or None when it carries none.

    The terminator is **structural, not class-based**: any node exposing one
    of TEXT_INPUT_KEYS as a plain string is a text carrier. Matching
    ``class_type == "CLIPTextEncode"`` would miss CLIPTextEncodeSDXL, smZ
    CLIPTextEncode, ttN text, Textbox, PrimitiveNode and every other
    community encoder — the string input is what actually identifies one.
    """
    for key in TEXT_INPUT_KEYS:
        value = inputs.get(key)
        if isinstance(value, str):
            return value
    return None


def _inputs_of(node: Any) -> dict[str, Any]:
    inputs = node.get("inputs") if isinstance(node, dict) else None
    return inputs if isinstance(inputs, dict) else {}


# ---------------------------------------------------------------------------
# ComfyUI API-format graph
# ---------------------------------------------------------------------------


def _load_graph(text: Any) -> dict[str, Any] | None:
    """Parse the API-format graph (``{node_id: {class_type, inputs}}``), or None.

    Requires at least one value to be a dict with a *string* ``class_type`` —
    otherwise the JSON parsed but isn't a Comfy graph, and claiming
    ``source="comfyui"`` for it would mislabel the file.
    """
    if not isinstance(text, str) or not text:
        return None
    try:
        graph = json.loads(text)
    except (ValueError, TypeError):
        return None
    if not isinstance(graph, dict):
        return None
    for node in graph.values():
        if isinstance(node, dict) and isinstance(node.get("class_type"), str):
            return graph
    return None


def _is_sampler(class_type: str) -> bool:
    return (
        class_type in SAMPLER_CLASSES
        or class_type.endswith("Sampler")
        or class_type.endswith("SamplerAdvanced")
        or "KSampler" in class_type
    )


def _upstream_ids(graph: dict[str, Any], node_id: str) -> set[str]:
    """Every node reachable by following ``node_id``'s input links backwards.

    Same bounded BFS as ``_walk`` (cycles and depth included) but collecting
    ids instead of stopping at the first hit — ``_pick_sampler`` needs the whole
    ancestor set, not one value. ``node_id`` itself is excluded, so a graph that
    loops back onto a sampler does not make that sampler consume itself.
    """
    seen: set[str] = set()
    queue: deque[tuple[str, int]] = deque([(node_id, 0)])
    while queue:
        nid, depth = queue.popleft()
        if nid in seen or depth > MAX_LINK_DEPTH or len(seen) > MAX_LINK_NODES:
            continue
        seen.add(nid)
        for value in _inputs_of(graph.get(nid)).values():
            if _is_link(value):
                nxt = str(value[0])
                if nxt in graph and nxt not in seen:
                    queue.append((nxt, depth + 1))
    seen.discard(node_id)
    return seen


def _pick_sampler(graph: dict[str, Any]) -> dict[str, Any] | None:
    """Choose the sampler node whose output is the image, or None if unknowable.

    Hires-fix and refiner workflows hold two or three samplers, and only the
    **last** one in the latent chain made the pixels in the file. So the first
    filter is the wiring: a sampler that another sampler consumes (reachable
    backwards from it through any link — latent upscale, VAE decode/encode,
    whatever sits between the passes) cannot be the one that produced this
    image. Ordering by "richest, then lowest numeric id" instead reported the
    *first* pass's seed/steps/cfg/sampler for a two-pass graph: node id order is
    deterministic but it is not evidence, and a wrong seed is worse than an
    absent one — paste it back and you get a different image.

    Among the terminal samplers, richness (readable widgets + conditioning
    inputs) then decides, so a stub sampler never outranks the real one. If the
    richest is still a tie — two disconnected equally-readable samplers, an
    XY-plot or a batch graph — the graph genuinely does not say which one made
    the file, so this returns None and the summary keys stay absent. Same
    honesty rule as ``_prompt_summary``: an unresolved value is omitted, never
    coin-flipped.

    A *-Sampler*-suffixed helper must corroborate its name with at least one
    readable widget or a conditioning input — otherwise a bare
    ``KSamplerSelect`` (which only holds ``sampler_name``) would outrank the
    real sampler. A canonical SAMPLER_CLASSES node needs no corroboration:
    ``SamplerCustomAdvanced`` legitimately holds nothing but links.
    """
    scored: dict[str, tuple[int, dict[str, Any]]] = {}
    for node_id, node in graph.items():
        if not isinstance(node, dict):
            continue
        class_type = node.get("class_type")
        if not isinstance(class_type, str) or not _is_sampler(class_type):
            continue
        inputs = _inputs_of(node)
        widgets = sum(1 for name in SAMPLER_WIDGETS if _scalar(inputs.get(name)) is not None)
        conds = sum(1 for name in ("positive", "negative") if name in inputs)
        if class_type not in SAMPLER_CLASSES and not widgets and not conds:
            continue
        scored[str(node_id)] = (widgets + conds, node)
    if not scored:
        return None
    if len(scored) == 1:
        return next(iter(scored.values()))[1]
    ids = set(scored)
    consumed: set[str] = set()
    for node_id in ids:
        consumed |= _upstream_ids(graph, node_id) & ids
    # Samplers wired into a cycle (hand-edited graphs do this) leave nothing
    # terminal; fall back to the whole set rather than to no answer at all, and
    # let the richness tie-break below decide or abstain.
    terminal = (ids - consumed) or ids
    best = max(scored[node_id][0] for node_id in terminal)
    winners = [node_id for node_id in terminal if scored[node_id][0] == best]
    if len(winners) != 1:
        return None
    return scored[winners[0]][1]


def _walk(
    graph: dict[str, Any],
    ref: Any,
    pick: Callable[[dict[str, Any]], Any],
) -> Any:
    """BFS from a ``[node_id, slot]`` ref, returning the first non-None ``pick``.

    Expansion enqueues **every** list-valued input, in ``inputs`` order (which
    is ComfyUI's serialisation order), rather than a hardcoded name list —
    that is what makes ``SamplerCustomAdvanced -> CFGGuider -> positive`` and
    long ``ConditioningSetTimestepRange``/``ControlNetApply``/
    ``ConditioningZeroOut`` chains resolve with zero per-class knowledge.
    Breadth-first so the *nearest* match wins, which is also what makes the
    result deterministic; ``seen`` is the cycle guard (ConditioningCombine
    loops and hand-edited graphs really do cycle).
    """
    if not _is_link(ref):
        return None
    start = str(ref[0])
    if start not in graph:
        return None
    queue: deque[tuple[str, int]] = deque([(start, 0)])
    seen: set[str] = set()
    while queue:
        node_id, depth = queue.popleft()
        if node_id in seen or depth > MAX_LINK_DEPTH or len(seen) > MAX_LINK_NODES:
            continue
        seen.add(node_id)
        inputs = _inputs_of(graph.get(node_id))
        hit = pick(inputs)
        if hit is not None:
            return hit
        for value in inputs.values():
            if _is_link(value):
                nxt = str(value[0])
                if nxt in graph and nxt not in seen:
                    queue.append((nxt, depth + 1))
    return None


def _resolve(
    graph: dict[str, Any],
    ref: Any,
    wanted: tuple[str, ...],
    *,
    want_text: bool = False,
) -> str | None:
    """Follow a link to the nearest widget value in ``wanted`` (or prompt text).

    ``wanted`` is checked in order within each node, so when one node holds
    several of the names the tuple's preference wins.
    """
    if want_text:
        return _walk(graph, ref, _text_of)

    def pick(inputs: dict[str, Any]) -> str | None:
        for name in wanted:
            value = _scalar(inputs.get(name))
            if value is not None:
                return value
        return None

    return _walk(graph, ref, pick)


def _cond_inputs(graph: dict[str, Any], inputs: dict[str, Any]) -> dict[str, Any]:
    """Return the inputs dict that actually carries positive/negative.

    KSampler holds the two conditioning links itself; SamplerCustomAdvanced
    delegates them to a guider (``CFGGuider``/``BasicGuider``), so follow that
    link to whichever node really has them. Reading the two refs off one node
    is what keeps positive and negative distinguishable — a want_text BFS from
    the guider would just return whichever prompt happened to be nearer.
    """
    if "positive" in inputs or "negative" in inputs:
        return inputs
    for name in ("guider", "model"):
        found = _walk(
            graph,
            inputs.get(name),
            lambda i: i if ("positive" in i or "negative" in i) else None,
        )
        if isinstance(found, dict):
            return found
    return inputs


# Nodes that hold BOTH prompts as plain strings on one node, rather than as
# two conditioning links. kijai's WanVideoTextEncode is the case that matters
# (1215 files on the reference install): the sampler reaches it through a
# ``text_embeds`` link, and the two roles are named on the node itself.
#
# This is the same guarantee _prompt_summary demands of the link path — both
# roles read off ONE node, so they stay distinguishable — expressed as widget
# names instead of links. It is emphatically NOT the forbidden fallback of
# picking whichever text node looks prompt-shaped.
PAIRED_PROMPT_WIDGETS = (("positive", "positive_prompt"), ("negative", "negative_prompt"))


def _paired_prompts(graph: dict[str, Any], inputs: dict[str, Any]) -> dict[str, str]:
    """Prompts from a single node naming both roles as widgets (Wan-style)."""

    def pick(node_inputs: dict[str, Any]) -> dict[str, str] | None:
        found = {
            role: node_inputs[key]
            for role, key in PAIRED_PROMPT_WIDGETS
            if isinstance(node_inputs.get(key), str)
        }
        return found or None

    for ref in inputs.values():
        found = _walk(graph, ref, pick)
        if isinstance(found, dict):
            return found
    return {}


def _prompt_summary(graph: dict[str, Any], inputs: dict[str, Any]) -> dict[str, str]:
    """Resolve positive/negative for one sampler's inputs. Roles come from links.

    There is **no fallback here on purpose.** A prompt's *role* is knowable only
    from the wiring: the two refs have to be read off one node (see
    _cond_inputs) and followed separately. Guessing from the graph's text nodes
    — "the only one is the positive", "the non-empty one of two is the positive"
    — reads plausibly and is wrong exactly when it matters: an empty positive
    plus a filled negative reports the *negative* as the prompt, and a user who
    copies that gets a materially different image. So an unresolved role leaves
    the key absent (the UI omits it), while a resolved-but-empty prompt stays as
    ``""`` because that value really was read.
    """
    cond = _cond_inputs(graph, inputs)
    summary: dict[str, str] = {}
    for key in ("positive", "negative"):
        prompt = _resolve(graph, cond.get(key), (), want_text=True)
        if prompt is not None:
            summary[key] = prompt
    if summary:
        return summary
    # No conditioning links resolved. Two more shapes, both role-determined:
    # a node naming both prompts as widgets (Wan), or an unguided single
    # conditioning (BasicGuider — MiniMax H3, and the core Flux/SD3 path).
    paired = _paired_prompts(graph, inputs)
    if paired:
        return paired
    single = _resolve(graph, _single_conditioning(graph, inputs), (), want_text=True)
    return {"positive": single} if single is not None else {}


def _single_conditioning(graph: dict[str, Any], inputs: dict[str, Any]) -> Any:
    """The lone conditioning link of an unguided guider, or None.

    ``BasicGuider`` takes one ``conditioning`` and no negative, because CFG
    does not apply on that path — so its single link is unambiguously the
    positive. The role comes from the node's contract (there is nothing else it
    could be), not from choosing between two candidates, which is what
    _prompt_summary's no-fallback rule forbids. A node exposing ``positive`` or
    ``negative`` is excluded so this can never pre-empt the link path above.
    """

    def pick(node_inputs: dict[str, Any]) -> Any:
        if "positive" in node_inputs or "negative" in node_inputs:
            return None
        ref = node_inputs.get("conditioning")
        return ref if _is_link(ref) else None

    return _walk(graph, inputs.get("guider"), pick)


def _from_api_graph(text: Any) -> tuple[str, dict[str, str]]:
    """Summarise the API-format ``prompt`` graph, the preferred source."""
    graph = _load_graph(text)
    if graph is None:
        return "", {}
    summary: dict[str, str] = {}
    node = _pick_sampler(graph)
    if node is not None:
        inputs = _inputs_of(node)
        for key, names, link_names in SUMMARY_WIDGETS:
            value = next((v for v in map(_scalar, map(inputs.get, names)) if v is not None), None)
            if value is None:
                for link_name in link_names:
                    value = _resolve(graph, inputs.get(link_name), names)
                    if value is not None:
                        break
            if value is not None:
                summary[key] = value
        summary.update(_prompt_summary(graph, inputs))
        # SamplerCustomAdvanced routes the model through its guider, so try
        # that alias too — the generic BFS does the rest from either ref.
        for ref_name in ("model", "guider"):
            model = _resolve(graph, inputs.get(ref_name), MODEL_KEYS)
            if model is not None:
                summary["model"] = model
                break
    return "comfyui", summary


def _looks_like_text_node(node_type: str) -> bool:
    lowered = node_type.lower()
    return "cliptextencode" in lowered or "text" in lowered or "prompt" in lowered


def _ui_links(data: dict[str, Any]) -> dict[str, list[Any]]:
    """Map link id -> ``[origin_node_id, origin_slot]`` from a UI workflow.

    The UI format keeps its wiring in a flat ``links`` array
    (``[link_id, origin_id, origin_slot, target_id, target_slot, type]``);
    newer serialisers emit the same three numbers as an object, so both shapes
    are accepted rather than dropping every link on a frontend bump.
    """
    out: dict[str, list[Any]] = {}
    links = data.get("links")
    for link in links if isinstance(links, list) else ():
        if isinstance(link, list | tuple) and len(link) >= 3:
            out[str(link[0])] = [str(link[1]), link[2]]
        elif isinstance(link, dict) and link.get("id") is not None:
            out[str(link["id"])] = [str(link.get("origin_id")), link.get("origin_slot", 0)]
    return out


def _ui_to_api_graph(data: dict[str, Any]) -> dict[str, Any]:
    """Rewrite a UI-format ``workflow`` into the API shape the walkers speak.

    Each UI node names its sockets in its own ``inputs`` list and references a
    link id, so the very ``[node_id, slot]`` refs the API format inlines can be
    reconstructed exactly. That is the whole point: ``_pick_sampler`` /
    ``_cond_inputs`` / ``_walk`` then run unchanged over a workflow-only file
    and keep positive and negative apart from the *wiring*, with no per-format
    prompt heuristic to get wrong.

    Only the leading string of a text-ish node crosses over as a value.
    ``widgets_values`` is positional with no names, so index -> steps/cfg is
    guesswork that silently mislabels across frontend versions (that asymmetry
    with ``_from_api_graph`` is deliberate — an absent seed is honest, a wrong
    one is not). The ``_looks_like_text_node`` gate is the UI analogue of
    ``TEXT_INPUT_KEYS``: without it a CheckpointLoader's ``ckpt_name`` — also a
    bare leading string, and reachable from an encoder's ``clip`` input — could
    be walked up and reported as the prompt.
    """
    links = _ui_links(data)
    graph: dict[str, Any] = {}
    nodes = data.get("nodes")
    for node in nodes if isinstance(nodes, list) else ():
        if not isinstance(node, dict):
            continue
        node_type = node.get("type")
        if not isinstance(node_type, str):
            continue
        inputs: dict[str, Any] = {}
        # ``slot``, not ``socket``: the registry scanner's network tripwire is a
        # bare ``socket.\w`` match, so a local named ``socket`` gets this pack's
        # publish flagged for network operations it does not perform (there is a
        # tests/test_publish_hygiene.py case for exactly this). LiteGraph calls
        # them input slots anyway.
        slots = node.get("inputs")
        for slot in slots if isinstance(slots, list) else ():
            if not isinstance(slot, dict):
                continue
            name = slot.get("name")
            ref = links.get(str(slot.get("link")))
            if isinstance(name, str) and ref is not None:
                inputs[name] = ref
        if _looks_like_text_node(node_type):
            values = node.get("widgets_values")
            if isinstance(values, list) and values and isinstance(values[0], str):
                # setdefault, not assignment: a widget converted to an input has
                # a live link plus a stale widgets_values entry, and the link is
                # the one that says where the text actually comes from.
                inputs.setdefault("text", values[0])
        graph[str(node.get("id", ""))] = {"class_type": node_type, "inputs": inputs}
    return graph


def _from_ui_graph(text: Any) -> tuple[str, dict[str, str]]:
    """Prompts only, from the UI-format ``workflow`` graph.

    Reads **no numbers** (see ``_ui_to_api_graph``), and reads the two prompts
    through the same link walk the API graph uses, so an empty positive beside
    a filled negative reports them the right way round instead of promoting
    whichever text node happened to be non-empty.
    """
    if not isinstance(text, str) or not text:
        return "", {}
    try:
        data = json.loads(text)
    except (ValueError, TypeError):
        return "", {}
    if not isinstance(data, dict) or not isinstance(data.get("nodes"), list):
        return "", {}
    graph = _ui_to_api_graph(data)
    node = _pick_sampler(graph)
    if node is None:
        # A real Comfy workflow with no recognisable sampler: still "comfyui"
        # (the container did carry a workflow), just nothing to summarise.
        return "comfyui", {}
    return "comfyui", _prompt_summary(graph, _inputs_of(node))


# ---------------------------------------------------------------------------
# A1111 / Forge parameter block
# ---------------------------------------------------------------------------

# Keys that may hold the classic text block, in order of trustworthiness.
A1111_KEYS = ("parameters", "UserComment", "Comment", "ImageDescription", "Description")
# Tokens that make a blob a generation block rather than a caption.
A1111_MARKERS = ("Steps:", "Sampler:", "CFG scale:")
# ... plus Seed:, for recognising the trailing settings line specifically.
A1111_SETTING_MARKERS = (*A1111_MARKERS, "Seed:")
# How far back from the end to look for that settings line. It is NOT reliably
# the last line: Forge appends ``Template:``, civitai and other re-taggers
# append ``Hashes: {...}``, ADetailer appends its own ``ADetailer model:``
# lines. Trusting ``lines[-1]`` meant one trailing line pushed the whole
# settings line into the reported NEGATIVE prompt and dropped
# seed/steps/cfg/sampler/model entirely. The scan is bounded twice over — by
# this count, and by the shape of the lines it crosses (every trailing block a
# writer appends is itself ``Key: value``, so a plain prose line means we are
# back inside the prompt and must stop).
A1111_TAIL_SCAN = 8
# Settings token -> summary key. Everything else (Model hash, Size, VAE,
# Version, Lora hashes, …) is deliberately dropped.
A1111_FIELDS = {
    "Steps": "steps",
    "Sampler": "sampler",
    "Schedule type": "scheduler",
    "CFG scale": "cfg",
    "Seed": "seed",
    "Model": "model",
}


def _split_settings(settings: str) -> list[tuple[str, str]]:
    """Split a ``k: v, k: v`` settings line into pairs, honouring quotes.

    A1111 emits values that contain commas inside quotes (``Lora hashes: "a:
    1, b: 2"``, ``Hires prompt: "x, y"``), so a plain ``split(",")`` shreds
    them into bogus tokens. Split on ``,`` at quote depth 0 only, then on the
    **first** ``": "`` so a value containing a colon survives.
    """
    chunks: list[str] = []
    quoted = False
    token: list[str] = []
    for ch in settings:
        if ch == '"':
            quoted = not quoted
        if ch == "," and not quoted:
            chunks.append("".join(token))
            token = []
            continue
        token.append(ch)
    chunks.append("".join(token))
    pairs: list[tuple[str, str]] = []
    for chunk in chunks:
        if ": " not in chunk:
            continue
        key, value = chunk.split(": ", 1)
        pairs.append((key.strip(), value.strip()))
    return pairs


def _is_settings_line(line: str) -> bool:
    """True for the ``Steps: 20, Sampler: …, Seed: …`` params line, by shape."""
    return ": " in line and any(m in line for m in A1111_SETTING_MARKERS)


def _split_off_settings(lines: list[str]) -> tuple[str, str]:
    """Split a block into (prompt body, settings line) — position-independent.

    Scans backwards over the trailing ``Key: value`` lines writers append (see
    A1111_TAIL_SCAN) for the params line, and drops everything after it: those
    tails are somebody else's metadata, not prompt text, and splicing them onto
    the negative prompt is the exact failure this replaces. Stops at the first
    line that is not ``Key: value``, which is prompt prose again.
    """
    for i in range(len(lines) - 1, max(-1, len(lines) - 1 - A1111_TAIL_SCAN), -1):
        if _is_settings_line(lines[i]):
            return "\n".join(lines[:i]), lines[i]
        if ": " not in lines[i]:
            break
    return "\n".join(lines), ""


def _put_prompt(summary: dict[str, str], key: str, text: str) -> None:
    """Record a prompt, unless it still carries settings tokens.

    A prompt containing ``Steps:``/``Sampler:``/``Seed:`` is not a prompt, it is
    an unsplit params block (a tail longer than A1111_TAIL_SCAN, or a shape we
    do not recognise). The module's rule is that an absent key beats a wrong
    one, and this value would be copied straight back into another tool.
    """
    if not _is_settings_line(text):
        summary[key] = text


def _parse_a1111_block(text: str) -> dict[str, str]:
    """Parse one classic A1111/Forge block into a summary."""
    body, settings = _split_off_settings(text.strip().split("\n"))
    summary: dict[str, str] = {}
    marker = "Negative prompt:"
    if marker in body:
        positive, negative = body.split(marker, 1)
        _put_prompt(summary, "positive", positive.rstrip())
        _put_prompt(summary, "negative", negative.strip())
    elif body.strip():
        _put_prompt(summary, "positive", body.strip())
    for token, value in _split_settings(settings):
        key = A1111_FIELDS.get(token)
        # Never split a trailing "Karras"/"Exponential" out of
        # "Sampler: DPM++ 2M Karras" into scheduler — that is inference, not
        # data. scheduler stays absent unless "Schedule type" is present.
        if key and key not in summary and value:
            summary[key] = value
    return summary


def _from_a1111(raw: dict[str, str]) -> tuple[str, dict[str, str]]:
    """Find and parse an A1111/Forge parameter block in the raw mapping."""
    for key in A1111_KEYS:
        text = raw.get(key)
        if not isinstance(text, str) or not text.strip():
            continue
        if "Negative prompt:" not in text and not any(m in text for m in A1111_MARKERS):
            # A bare camera caption in Comment/ImageDescription must not be
            # promoted to a prompt.
            continue
        summary = _parse_a1111_block(text)
        if summary:
            return "a1111", summary
    return "", {}
