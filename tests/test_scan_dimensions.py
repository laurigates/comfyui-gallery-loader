"""Image dimensions in /list rows — the probe the PIL stub hides (#86 §4).

tests/conftest.py stubs ``PIL`` with MagicMocks, so under the default harness
``Image.open(path)`` hands back a MagicMock whose ``__enter__`` result has a
MagicMock ``.size``. Unpacking that raises, ``_scan_file_entry``'s own
``except`` swallows it, and every row comes back ``width: None, height: None``.
Nothing asserted dimensions, which is right for that harness — and means a
change that broke the probe outright (wrong attribute, wrong gate, the
assignment dropped) was invisible to every test.

The stand-in below is not a MagicMock: it reads the real IHDR chunk out of the
real file on disk, exactly the header-only read PIL's lazy ``open`` performs,
and fails on anything that is not a PNG the way PIL does. So the numbers a row
carries are the file's, and a probe that stopped reaching them shows up as
``None`` where an integer was expected.
"""

from __future__ import annotations

import asyncio
import struct
import zlib

import folder_paths  # the conftest stub
import pytest

import gallery_loader

PNG_SIG = b"\x89PNG\r\n\x1a\n"


def _chunk(ctype: bytes, data: bytes) -> bytes:
    body = ctype + data
    return struct.pack(">I", len(data)) + body + struct.pack(">I", zlib.crc32(body) & 0xFFFFFFFF)


def _png(width: int, height: int) -> bytes:
    ihdr = struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)
    return (
        PNG_SIG
        + _chunk(b"IHDR", ihdr)
        + _chunk(b"IDAT", zlib.compress(b"\x00\xff\x00\x00"))
        + _chunk(b"IEND", b"")
    )


class _HeaderOnlyImage:
    """What ``with Image.open(path) as im: im.size`` touches, and no more."""

    def __init__(self, size):
        self.size = size

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


class _IHDRReader:
    """A ``PIL.Image`` stand-in whose ``open`` reads the file's real header.

    Records every path it was asked to open, so a test can also assert which
    rows were probed — the video gate is a statement about calls, not values.
    """

    def __init__(self):
        self.opened: list[str] = []

    def open(self, path):
        self.opened.append(str(path))
        with open(path, "rb") as f:
            head = f.read(24)
        if len(head) < 24 or head[:8] != PNG_SIG or head[12:16] != b"IHDR":
            # PIL raises UnidentifiedImageError (an OSError) here.
            raise OSError(f"cannot identify image file {path!r}")
        w, h = struct.unpack(">II", head[16:24])
        return _HeaderOnlyImage((w, h))


@pytest.fixture
def reader(monkeypatch):
    r = _IHDRReader()
    monkeypatch.setattr(gallery_loader, "Image", r)
    return r


@pytest.fixture
def root(tmp_path, monkeypatch):
    monkeypatch.setattr(
        folder_paths, "get_directory_by_type", lambda t: str(tmp_path), raising=False
    )
    return tmp_path


def _rows(get_request, query):
    resp = asyncio.run(gallery_loader.gallery_list(get_request(query)))
    assert resp.status == 200
    return {f["name"]: f for f in resp._body["files"]}


def test_folder_listing_carries_each_image_s_own_dimensions(root, reader, get_request):
    # Two different sizes, so a probe that reported one constant — or the
    # first file's size for every row — cannot pass.
    (root / "wide.png").write_bytes(_png(640, 360))
    (root / "tall.png").write_bytes(_png(90, 160))
    rows = _rows(get_request, {"type": "output", "subfolder": ""})
    assert (rows["wide.png"]["width"], rows["wide.png"]["height"]) == (640, 360)
    assert (rows["tall.png"]["width"], rows["tall.png"]["height"]) == (90, 160)


def test_flat_listing_probes_through_the_same_row_builder(root, reader, get_request):
    # The recursive lister builds its rows through _scan_file_entry too; a
    # flat view whose cards lost their WxH line would otherwise go unnoticed.
    (root / "a" / "b").mkdir(parents=True)
    (root / "a" / "b" / "deep.png").write_bytes(_png(33, 44))
    rows = _rows(get_request, {"type": "output", "subfolder": "", "recursive": "1"})
    assert rows["deep.png"]["subpath"] == "a/b"
    assert (rows["deep.png"]["width"], rows["deep.png"]["height"]) == (33, 44)


def test_a_video_is_never_handed_to_the_image_probe(root, reader, get_request):
    # The gate is `ext in image_subset`. Paired with an image in the same
    # listing, so "nothing was probed" cannot pass by the probe being dead.
    (root / "still.png").write_bytes(_png(8, 8))
    (root / "clip.mp4").write_bytes(b"\x00\x00\x00\x18ftypmp42")
    rows = _rows(get_request, {"type": "output", "subfolder": "", "extensions": ".png,.mp4"})
    assert (rows["clip.mp4"]["width"], rows["clip.mp4"]["height"]) == (None, None)
    assert (rows["still.png"]["width"], rows["still.png"]["height"]) == (8, 8)
    assert [p.rsplit("/", 1)[-1] for p in reader.opened] == ["still.png"]


def test_an_unreadable_image_costs_its_dimensions_not_the_listing(root, reader, get_request):
    # Best-effort probe: one corrupt file must not fail the listing, nor take
    # its neighbour's dimensions down with it.
    (root / "broken.png").write_bytes(b"not a png at all")
    (root / "fine.png").write_bytes(_png(12, 34))
    rows = _rows(get_request, {"type": "output", "subfolder": ""})
    assert (rows["broken.png"]["width"], rows["broken.png"]["height"]) == (None, None)
    assert (rows["fine.png"]["width"], rows["fine.png"]["height"]) == (12, 34)
