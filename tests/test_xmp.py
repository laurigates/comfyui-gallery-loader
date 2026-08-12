"""Unit tests for xmp_meta — pure byte-level XMP read/write helpers.

xmp_meta has no ComfyUI imports, so these run in a bare environment. The
PNG/JPEG round-trips build minimal valid containers in memory to prove the
splice is lossless (other chunks/segments survive byte-for-byte).
"""

import struct
import zlib

import pytest

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


# ---------- read-modify-write: foreign properties survive --------------
#
# The bug this section exists for: a rating write used to build a brand-new
# packet holding nothing but xmp:Rating, so writing a star onto any file
# previously tagged in digiKam / Lightroom / Bridge silently destroyed its
# keywords, caption, creator and rights. Nothing in the pack read those
# fields, so nothing noticed.


def _foreign_packet(rating: str | None = "2") -> bytes:
    """A digiKam-shaped packet: our rating plus five properties we don't own,
    in both legal serialisations (attributes AND child elements)."""
    rating_attr = f'\n    xmp:Rating="{rating}"' if rating is not None else ""
    xml = (
        '<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?>\n'
        '<x:xmpmeta xmlns:x="adobe:ns:meta/" x:xmptk="digiKam-8.4.0">\n'
        ' <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">\n'
        '  <rdf:Description rdf:about=""\n'
        '    xmlns:dc="http://purl.org/dc/elements/1.1/"\n'
        '    xmlns:xmp="http://ns.adobe.com/xap/1.0/"'
        f"{rating_attr}\n"
        '    xmp:CreatorTool="digiKam">\n'
        "   <dc:subject>\n"
        "    <rdf:Bag>\n"
        "     <rdf:li>sunset</rdf:li>\n"
        "     <rdf:li>beach &amp; sand</rdf:li>\n"
        "    </rdf:Bag>\n"
        "   </dc:subject>\n"
        "   <dc:description>\n"
        '    <rdf:Alt><rdf:li xml:lang="x-default">A caption</rdf:li></rdf:Alt>\n'
        "   </dc:description>\n"
        "   <dc:creator><rdf:Seq><rdf:li>Jane Photographer</rdf:li></rdf:Seq></dc:creator>\n"
        "   <dc:rights>CC-BY-4.0</dc:rights>\n"
        "  </rdf:Description>\n"
        " </rdf:RDF>\n"
        "</x:xmpmeta>\n"
    )
    return (xml + " " * 64 + "\n" + '<?xpacket end="w"?>').encode("utf-8")


def _assert_foreign_survived(packet: bytes) -> None:
    """Every property we do not own is still there, under its own prefix."""
    assert packet is not None, "no XMP packet left in the file at all"
    text = packet.decode("utf-8")
    # dc:subject keywords, including the one carrying an escaped entity.
    assert "<dc:subject>" in text
    assert "<rdf:li>sunset</rdf:li>" in text
    assert "beach &amp; sand" in text
    # Caption, creator, rights, and the foreign xmp: property next to ours.
    assert "A caption" in text
    assert "Jane Photographer" in text
    assert "<dc:rights>CC-BY-4.0</dc:rights>" in text
    assert 'xmp:CreatorTool="digiKam"' in text
    assert 'x:xmptk="digiKam-8.4.0"' in text
    # The xml: prefix is bound by the spec and must not be re-invented, or
    # the caption's language qualifier stops being a language qualifier.
    assert 'xml:lang="x-default"' in text


def _png_with_xmp(packet: bytes) -> bytes:
    return _make_png(extra_chunks=xmp_meta._make_itxt(xmp_meta.PNG_XMP_KEYWORD, packet))


def _jpeg_with_xmp(packet: bytes) -> bytes:
    payload = xmp_meta.JPEG_XMP_PREFIX + packet
    app1 = b"\xff\xe1" + (2 + len(payload)).to_bytes(2, "big") + payload
    jpeg = _make_jpeg()
    app0_end = 4 + int.from_bytes(jpeg[4:6], "big")  # SOI + APP0 marker + length
    return jpeg[:app0_end] + app1 + jpeg[app0_end:]


def test_update_with_no_existing_packet_is_byte_identical_to_build():
    # Fresh ComfyUI renders have no XMP; their output must not change at all.
    for r in range(6):
        assert xmp_meta.update_xmp_packet(None, r) == xmp_meta.build_xmp_packet(r)
        assert xmp_meta.update_xmp_packet(b"", r) == xmp_meta.build_xmp_packet(r)


def test_update_preserves_foreign_properties_and_sets_rating():
    out = xmp_meta.update_xmp_packet(_foreign_packet(rating="2"), 5)
    _assert_foreign_survived(out)
    assert xmp_meta.parse_rating_from_xmp(out) == 5
    assert b'xmp:Rating="5"' in out
    assert b'xmp:Rating="2"' not in out
    assert b'MicrosoftPhoto:Rating="99"' in out


def test_update_adds_rating_to_a_packet_that_had_none():
    out = xmp_meta.update_xmp_packet(_foreign_packet(rating=None), 3)
    _assert_foreign_survived(out)
    assert xmp_meta.parse_rating_from_xmp(out) == 3


def test_update_strips_the_element_form_of_our_rating():
    # A rating left in element form would shadow the attribute we write:
    # _find_rating takes whichever it meets first walking the tree.
    packet = (
        b'<x:xmpmeta xmlns:x="adobe:ns:meta/">'
        b'<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">'
        b'<rdf:Description xmlns:xmp="http://ns.adobe.com/xap/1.0/"'
        b' xmlns:MicrosoftPhoto="http://ns.microsoft.com/photo/1.0/"'
        b' xmlns:dc="http://purl.org/dc/elements/1.1/">'
        b"<xmp:Rating>1</xmp:Rating>"
        b"<MicrosoftPhoto:Rating>1</MicrosoftPhoto:Rating>"
        b"<dc:rights>CC-BY-4.0</dc:rights>"
        b"</rdf:Description></rdf:RDF></x:xmpmeta>"
    )
    out = xmp_meta.update_xmp_packet(packet, 4)
    assert b"<xmp:Rating>" not in out
    assert b"<MicrosoftPhoto:Rating>" not in out
    assert b"<dc:rights>CC-BY-4.0</dc:rights>" in out
    assert xmp_meta.parse_rating_from_xmp(out) == 4


def test_update_re_escapes_a_newline_in_a_preserved_attribute():
    # `&#10;` is the only way an attribute can hold a real newline: a LITERAL
    # newline is normalised to a space by every XML parser, a character
    # reference is not. Writing the value back out raw therefore downgrades
    # it to a space on the next read — a multi-line caption flattened by a
    # star click. Two writes in a row is what exposes it.
    packet = (
        b'<x:xmpmeta xmlns:x="adobe:ns:meta/">'
        b'<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">'
        b'<rdf:Description xmlns:dc="http://purl.org/dc/elements/1.1/"'
        b' dc:title="line one&#10;line two"/>'
        b"</rdf:RDF></x:xmpmeta>"
    )
    once = xmp_meta.update_xmp_packet(packet, 1)
    assert b"line one&#10;line two" in once
    twice = xmp_meta.update_xmp_packet(once, 2)
    assert b"line one&#10;line two" in twice


@pytest.mark.parametrize(
    ("label", "packet"),
    [
        ("doctype", b'<!DOCTYPE x [<!ENTITY a "b">]><x:xmpmeta xmlns:x="adobe:ns:meta/"/>'),
        ("not xml", b"<x:xmpmeta unclosed"),
        ("oversize", b"<x/>" + b" " * (xmp_meta.MAX_XMP_BYTES + 1)),
        ("no rdf:RDF", b'<x:xmpmeta xmlns:x="adobe:ns:meta/"><other/></x:xmpmeta>'),
    ],
)
def test_update_refuses_a_packet_it_cannot_parse_safely(label, packet):
    # Refusing is the non-destructive answer: the caller writes a sidecar,
    # which read_rating reaches precisely because the same gate stops the
    # in-file packet from being read.
    assert xmp_meta.update_xmp_packet(packet, 3) is None, label


# ---------- read-modify-write through the real file backends -----------


def _packet_in(path, ext: str) -> bytes | None:
    if ext == ".png":
        return xmp_meta.png_get_xmp(path.read_bytes())
    if ext in (".jpg", ".jpeg"):
        return xmp_meta.jpeg_get_xmp(path.read_bytes())
    return xmp_meta.sidecar_read_packet(str(path))


def _seed(tmp_path, ext: str):
    p = tmp_path / f"a{ext}"
    if ext == ".png":
        p.write_bytes(_png_with_xmp(_foreign_packet()))
    elif ext == ".jpg":
        p.write_bytes(_jpeg_with_xmp(_foreign_packet()))
    else:
        p.write_bytes(b"RIFF????WEBP")
        (tmp_path / f"a{ext}.xmp").write_bytes(_foreign_packet())
    return p


@pytest.mark.parametrize(
    ("ext", "backend"), [(".png", "png"), (".jpg", "jpeg"), (".webp", "sidecar")]
)
def test_write_rating_preserves_foreign_properties(tmp_path, ext, backend):
    p = _seed(tmp_path, ext)
    ok, used = xmp_meta.write_rating(str(p), 5)
    assert (ok, used) == (True, backend)
    assert xmp_meta.read_rating(str(p)) == 5
    _assert_foreign_survived(_packet_in(p, ext))


@pytest.mark.parametrize("ext", [".png", ".jpg", ".webp"])
def test_rating_round_trip_keeps_foreign_properties_every_time(tmp_path, ext):
    p = _seed(tmp_path, ext)
    for r in (0, 3, 5, 0):
        ok, _backend = xmp_meta.write_rating(str(p), r)
        assert ok
        assert xmp_meta.read_rating(str(p)) == r, f"rating {r} did not round-trip"
        _assert_foreign_survived(_packet_in(p, ext))


def test_png_write_preserves_an_xmp_chunk_that_sits_after_idat(tmp_path):
    # png_set_xmp drops an XMP text chunk wherever it sits, so the write path
    # has to read past IDAT before replacing it — the cheap /list probe does
    # not, because it only ever reads the head of the file.
    ihdr = struct.pack(">IIBBBBB", 1, 1, 8, 2, 0, 0, 0)
    png = (
        xmp_meta.PNG_SIG
        + _png_chunk(b"IHDR", ihdr)
        + _png_chunk(b"IDAT", zlib.compress(b"\x00\xff\x00\x00"))
        + xmp_meta._make_itxt(xmp_meta.PNG_XMP_KEYWORD, _foreign_packet())
        + _png_chunk(b"IEND", b"")
    )
    assert xmp_meta.png_get_xmp(png) is None  # invisible to the head probe
    assert xmp_meta.png_get_xmp(png, stop_at_idat=False) is not None

    p = tmp_path / "a.png"
    p.write_bytes(png)
    assert xmp_meta.write_rating(str(p), 4) == (True, "png")
    # The replacement lands before IDAT, so the head probe now finds it.
    _assert_foreign_survived(xmp_meta.png_get_xmp(p.read_bytes()))
    assert xmp_meta.read_rating(str(p)) == 4


def test_update_strips_a_stale_rating_from_a_second_description():
    # XMP routinely splits vocabularies across sibling rdf:Description
    # elements. Setting ours on the first while leaving a copy on the second
    # writes a packet that disagrees with itself — and which of the two a
    # reader honours is down to its tree-walk order, not ours.
    packet = (
        b'<x:xmpmeta xmlns:x="adobe:ns:meta/">'
        b'<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"'
        b' xmlns:xmp="http://ns.adobe.com/xap/1.0/"'
        b' xmlns:MicrosoftPhoto="http://ns.microsoft.com/photo/1.0/"'
        b' xmlns:dc="http://purl.org/dc/elements/1.1/">'
        b'<rdf:Description rdf:about="" dc:rights="CC-BY-4.0"/>'
        b'<rdf:Description rdf:about="" xmp:Rating="1" MicrosoftPhoto:Rating="1"'
        b' xmp:CreatorTool="digiKam"/>'
        b"</rdf:RDF></x:xmpmeta>"
    )
    out = xmp_meta.update_xmp_packet(packet, 4)
    assert out.count(b"xmp:Rating") == 1, "a stale rating survived on the second Description"
    assert out.count(b"MicrosoftPhoto:Rating") == 1
    assert b'xmp:Rating="4"' in out
    assert xmp_meta.parse_rating_from_xmp(out) == 4
    # The second Description's foreign properties are untouched.
    assert b'xmp:CreatorTool="digiKam"' in out
    assert b'dc:rights="CC-BY-4.0"' in out


def test_png_write_refuses_to_clobber_an_unparseable_packet(tmp_path):
    evil = b'<!DOCTYPE x [<!ENTITY a "b">]><x:xmpmeta xmlns:x="adobe:ns:meta/">keep me</x:xmpmeta>'
    p = tmp_path / "a.png"
    p.write_bytes(_png_with_xmp(evil))

    ok, backend = xmp_meta.write_rating(str(p), 3)
    assert (ok, backend) == (True, "sidecar")
    # The packet we would not parse is still on disk, byte for byte.
    assert xmp_meta.png_get_xmp(p.read_bytes()) == evil
    # …and the rating is still readable, because an unreadable in-file packet
    # does not shadow the sidecar.
    assert xmp_meta.read_rating(str(p)) == 3


def test_sidecar_write_refuses_to_clobber_an_unparseable_sidecar(tmp_path):
    p = tmp_path / "a.webp"
    p.write_bytes(b"RIFF????WEBP")
    evil = b'<!DOCTYPE x [<!ENTITY a "b">]><x:xmpmeta xmlns:x="adobe:ns:meta/">keep me</x:xmpmeta>'
    (tmp_path / "a.webp.xmp").write_bytes(evil)

    assert xmp_meta.sidecar_set_rating(str(p), 3) is False
    ok, reason = xmp_meta.write_rating(str(p), 3)
    assert ok is False
    assert "sidecar" in reason
    assert (tmp_path / "a.webp.xmp").read_bytes() == evil


def test_sidecar_write_creates_a_fresh_packet_when_there_is_none(tmp_path):
    p = tmp_path / "a.webp"
    p.write_bytes(b"RIFF????WEBP")
    assert xmp_meta.sidecar_set_rating(str(p), 3) is True
    assert (tmp_path / "a.webp.xmp").read_bytes() == xmp_meta.build_xmp_packet(3)
