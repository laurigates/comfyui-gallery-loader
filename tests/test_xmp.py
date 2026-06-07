"""Unit tests for xmp_meta — pure byte-level XMP read/write helpers.

xmp_meta has no ComfyUI imports, so these run in a bare environment. The
PNG/JPEG round-trips build minimal valid containers in memory to prove the
splice is lossless (other chunks/segments survive byte-for-byte).
"""

import struct
import zlib

import xmp_meta

# ---------- rating <-> percent --------------------------------------


def test_rating_to_ms_percent_table():
    assert [xmp_meta.rating_to_ms_percent(r) for r in range(6)] == [0, 1, 25, 50, 75, 99]


def test_ms_percent_to_rating_exact_buckets():
    assert [xmp_meta.ms_percent_to_rating(p) for p in (0, 1, 25, 50, 75, 99)] == [0, 1, 2, 3, 4, 5]


def test_ms_percent_to_rating_nearest_bucket():
    assert xmp_meta.ms_percent_to_rating(60) == 3  # nearest 50
    assert xmp_meta.ms_percent_to_rating(90) == 5  # nearest 99
    assert xmp_meta.ms_percent_to_rating(13) == 1  # nearest 1 vs 25 -> 1
    assert xmp_meta.ms_percent_to_rating(200) == 5  # clamp


def test_clamp_rating():
    assert xmp_meta.clamp_rating(-3) == 0
    assert xmp_meta.clamp_rating(9) == 5
    assert xmp_meta.clamp_rating("x") == 0
    assert xmp_meta.clamp_rating(3) == 3


# ---------- packet build / parse ------------------------------------


def test_build_and_parse_round_trip_all_ratings():
    for r in range(6):
        pkt = xmp_meta.build_xmp_packet(r)
        assert b"<?xpacket" in pkt and b'end="w"' in pkt
        assert f'xmp:Rating="{r}"'.encode() in pkt
        assert xmp_meta.parse_rating_from_xmp(pkt) == r


def test_parse_rejects_doctype():
    evil = b'<?xml version="1.0"?><!DOCTYPE x [<!ENTITY a "b">]><x:xmpmeta/>'
    assert xmp_meta.parse_rating_from_xmp(evil) is None


def test_parse_rejects_oversize():
    big = b"<x/>" + b" " * (xmp_meta.MAX_XMP_BYTES + 1)
    assert xmp_meta.parse_rating_from_xmp(big) is None


def test_parse_element_form_rating():
    xml = (
        b'<x:xmpmeta xmlns:x="adobe:ns:meta/">'
        b'<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">'
        b'<rdf:Description xmlns:xmp="http://ns.adobe.com/xap/1.0/">'
        b"<xmp:Rating>4</xmp:Rating>"
        b"</rdf:Description></rdf:RDF></x:xmpmeta>"
    )
    assert xmp_meta.parse_rating_from_xmp(xml) == 4


def test_parse_microsoft_only_maps_percent():
    xml = (
        b'<x:xmpmeta xmlns:x="adobe:ns:meta/">'
        b'<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">'
        b'<rdf:Description xmlns:MicrosoftPhoto="http://ns.microsoft.com/photo/1.0/"'
        b' MicrosoftPhoto:Rating="75"/>'
        b"</rdf:RDF></x:xmpmeta>"
    )
    assert xmp_meta.parse_rating_from_xmp(xml) == 4


def test_parse_garbage_returns_none():
    assert xmp_meta.parse_rating_from_xmp(b"not xml") is None
    assert xmp_meta.parse_rating_from_xmp(b"") is None
    assert xmp_meta.parse_rating_from_xmp(None) is None


# ---------- PNG helpers ---------------------------------------------


def _png_chunk(ctype: bytes, data: bytes) -> bytes:
    body = ctype + data
    return struct.pack(">I", len(data)) + body + struct.pack(">I", zlib.crc32(body) & 0xFFFFFFFF)


def _make_png(extra_chunks: bytes = b"") -> bytes:
    ihdr = struct.pack(">IIBBBBB", 1, 1, 8, 2, 0, 0, 0)  # 1x1, RGB
    text = _png_chunk(b"tEXt", b"parameters\x00{fake comfy workflow}")
    idat = _png_chunk(b"IDAT", zlib.compress(b"\x00\xff\x00\x00"))
    iend = _png_chunk(b"IEND", b"")
    return xmp_meta.PNG_SIG + _png_chunk(b"IHDR", ihdr) + text + extra_chunks + idat + iend


def test_png_round_trip_preserves_other_chunks():
    png = _make_png()
    out = xmp_meta.png_set_xmp(png, xmp_meta.build_xmp_packet(4))

    # Signature + the ComfyUI tEXt chunk + IDAT survive byte-for-byte.
    assert out.startswith(xmp_meta.PNG_SIG)
    assert b"parameters\x00{fake comfy workflow}" in out
    assert _png_chunk(b"IDAT", zlib.compress(b"\x00\xff\x00\x00")) in out

    # Every chunk has a valid CRC and the XMP iTXt lands before IDAT.
    order = [ctype for ctype, _d, _s, _e in xmp_meta._iter_png_chunks(out)]
    assert order.index("iTXt") < order.index("IDAT")
    assert xmp_meta.parse_rating_from_xmp(xmp_meta.png_get_xmp(out)) == 4


def test_png_set_replaces_not_duplicates():
    png = _make_png()
    once = xmp_meta.png_set_xmp(png, xmp_meta.build_xmp_packet(4))
    twice = xmp_meta.png_set_xmp(once, xmp_meta.build_xmp_packet(2))
    itxt_count = sum(1 for ct, *_ in xmp_meta._iter_png_chunks(twice) if ct == "iTXt")
    assert itxt_count == 1
    assert xmp_meta.parse_rating_from_xmp(xmp_meta.png_get_xmp(twice)) == 2
    # ComfyUI metadata still intact after a second write.
    assert b"parameters\x00{fake comfy workflow}" in twice


# ---------- JPEG helpers --------------------------------------------


def _make_jpeg() -> bytes:
    soi = b"\xff\xd8"
    app0 = b"\xff\xe0" + (16).to_bytes(2, "big") + b"JFIF\x00\x01\x01\x00\x00\x01\x00\x01\x00\x00"
    dqt = b"\xff\xdb" + (5).to_bytes(2, "big") + b"\x00\x01\x02"
    sos = b"\xff\xda" + (3).to_bytes(2, "big") + b"\x00"
    scan = b"\x12\x34\x56\x78"
    eoi = b"\xff\xd9"
    return soi + app0 + dqt + sos + scan + eoi


def test_jpeg_round_trip_preserves_scan():
    jpeg = _make_jpeg()
    out = xmp_meta.jpeg_set_xmp(jpeg, xmp_meta.build_xmp_packet(5))
    assert out is not None
    # Scan + EOI preserved verbatim; XMP APP1 present and readable.
    assert out.endswith(b"\x12\x34\x56\x78\xff\xd9")
    assert xmp_meta.JPEG_XMP_PREFIX in out
    assert xmp_meta.parse_rating_from_xmp(xmp_meta.jpeg_get_xmp(out)) == 5
    # APP1 sits after the leading 18-byte APP0 (2 marker + 16 length+payload).
    assert out[2:4] == b"\xff\xe0"
    assert out[20:22] == b"\xff\xe1"


def test_jpeg_set_replaces_existing_xmp():
    jpeg = _make_jpeg()
    once = xmp_meta.jpeg_set_xmp(jpeg, xmp_meta.build_xmp_packet(5))
    assert once is not None
    twice = xmp_meta.jpeg_set_xmp(once, xmp_meta.build_xmp_packet(1))
    assert twice is not None
    assert twice.count(xmp_meta.JPEG_XMP_PREFIX) == 1
    assert xmp_meta.parse_rating_from_xmp(xmp_meta.jpeg_get_xmp(twice)) == 1


def test_jpeg_overflow_returns_none():
    jpeg = _make_jpeg()
    huge = b"x" * (xmp_meta.JPEG_APP1_MAX + 10)
    assert xmp_meta.jpeg_set_xmp(jpeg, huge) is None


# ---------- sidecar + dispatch (filesystem) -------------------------


def test_sidecar_round_trip(tmp_path):
    img = tmp_path / "foo.webp"
    img.write_bytes(b"RIFF????WEBP")
    assert xmp_meta.sidecar_path(str(img)) == str(img) + ".xmp"
    xmp_meta.sidecar_set_rating(str(img), 3)
    assert (tmp_path / "foo.webp.xmp").is_file()
    assert xmp_meta.sidecar_get_rating(str(img)) == 3


def test_write_rating_dispatch_png(tmp_path):
    p = tmp_path / "a.png"
    p.write_bytes(_make_png())
    ok, backend = xmp_meta.write_rating(str(p), 4)
    assert ok and backend == "png"
    assert xmp_meta.read_rating(str(p)) == 4


def test_write_rating_dispatch_sidecar_for_webp(tmp_path):
    p = tmp_path / "a.webp"
    p.write_bytes(b"RIFF????WEBP")
    ok, backend = xmp_meta.write_rating(str(p), 2)
    assert ok and backend == "sidecar"
    assert xmp_meta.read_rating(str(p)) == 2


def test_read_rating_prefers_in_file_over_sidecar(tmp_path):
    p = tmp_path / "a.png"
    p.write_bytes(xmp_meta.png_set_xmp(_make_png(), xmp_meta.build_xmp_packet(5)))
    # A conflicting sidecar should lose to the in-file rating.
    xmp_meta.sidecar_set_rating(str(p), 1)
    assert xmp_meta.read_rating(str(p)) == 5


def test_read_rating_unrated_is_zero(tmp_path):
    p = tmp_path / "a.png"
    p.write_bytes(_make_png())
    assert xmp_meta.read_rating(str(p)) == 0
