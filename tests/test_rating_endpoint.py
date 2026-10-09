"""POST /gallery_loader/rating, driven end to end through the shipped handler.

Its two layers were already covered as units — ``_validate_rating_request`` in
tests/test_helpers.py and ``xmp_meta.write_rating`` in tests/test_xmp.py — and
tests/test_write_containment.py drives the handler for the out-of-sandbox
refusal. What nothing reached is the handler that JOINS them: the
``invalid json`` branch, the validator's message passed through as the 400
body, the 404 ``_resolve_write_target`` answers for a file that is not there,
the writer's refusal surfacing as a 500, and the ``{ok, rating, backend}``
success body (#14).

Shaped after ``TestTagEndpoint`` in tests/test_safe_view.py. Every rejection is
paired with the acceptance of a request that differs ONLY in the thing under
test: a lone negative passes just as well against a handler wired to refuse
everything. Each rejection also asserts the FILESYSTEM was left alone, because
a sidecar write creates ``<name>.xmp`` and a status code alone cannot show that
nothing was written.
"""

from __future__ import annotations

import asyncio
import struct
import zlib

import folder_paths  # the conftest stub
import pytest

import gallery_loader
import xmp_meta


class _FakePostRequest:
    """A JSON POST that satisfies the ``_mutating_post`` Content-Type guard.

    tests/test_write_containment.py owns that guard's own coverage; here it
    only has to let the request through to the handler.
    """

    def __init__(self, body=None, *, raises=False):
        self._body = body
        self._raises = raises
        self.headers = {"Content-Type": "application/json"}

    async def json(self):
        if self._raises:
            # What aiohttp's BaseRequest.json raises on a body that is not JSON.
            raise ValueError("Expecting value: line 1 column 1 (char 0)")
        return self._body


def _chunk(ctype: bytes, data: bytes) -> bytes:
    body = ctype + data
    return struct.pack(">I", len(data)) + body + struct.pack(">I", zlib.crc32(body) & 0xFFFFFFFF)


def _png() -> bytes:
    """A minimal valid 1x1 PNG, so the writer takes the in-place PNG branch."""
    ihdr = struct.pack(">IIBBBBB", 1, 1, 8, 2, 0, 0, 0)
    return (
        xmp_meta.PNG_SIG
        + _chunk(b"IHDR", ihdr)
        + _chunk(b"IDAT", zlib.compress(b"\x00\xff\x00\x00"))
        + _chunk(b"IEND", b"")
    )


def _post(body=None, *, raises=False):
    return asyncio.run(gallery_loader.gallery_set_rating(_FakePostRequest(body, raises=raises)))


def _body(name="a.webp", rating=4, **extra):
    b = {"type": "output", "subfolder": "", "name": name, "rating": rating}
    b.update(extra)
    return b


@pytest.fixture
def root(tmp_path, monkeypatch):
    monkeypatch.setattr(
        folder_paths, "get_directory_by_type", lambda t: str(tmp_path), raising=False
    )
    return tmp_path


def _webp(directory, name="a.webp"):
    # Not a container the writer edits in place, so the write goes to a sidecar
    # — the branch every non-PNG/JPEG file in a folder takes.
    p = directory / name
    p.write_bytes(b"RIFF????WEBP")
    return p


def _sidecar(p):
    return p.parent / f"{p.name}.xmp"


class TestRatingEndpointSuccess:
    def test_writes_the_rating_and_answers_ok_rating_backend(self, root):
        p = _webp(root)
        resp = _post(_body(rating=4))
        assert resp.status == 200
        assert resp._body == {"ok": True, "rating": 4, "backend": "sidecar"}
        # Read back from disk, not from the response: the response is the
        # handler's claim, the file is what the next listing will show.
        assert xmp_meta.read_rating(str(p)) == 4

    def test_a_png_is_rated_in_place_and_says_so(self, root):
        # `backend` is what tells the frontend (and a reader of the network
        # log) where the star went. A hardcoded value would pass the sidecar
        # test above and fail here.
        p = root / "a.png"
        p.write_bytes(_png())
        resp = _post(_body(name="a.png", rating=2))
        assert resp.status == 200
        assert resp._body == {"ok": True, "rating": 2, "backend": "png"}
        assert not _sidecar(p).exists()
        assert xmp_meta.read_rating(str(p), head_only=False) == 2

    def test_rating_zero_clears_a_previous_star(self, root):
        # The picker's "tap the active star to clear" sends 0. Zero is falsy,
        # so a handler that tested `if rating:` anywhere would drop it.
        p = _webp(root)
        assert _post(_body(rating=3)).status == 200
        resp = _post(_body(rating=0))
        assert resp._body == {"ok": True, "rating": 0, "backend": "sidecar"}
        assert xmp_meta.read_rating(str(p)) == 0

    def test_a_subfolder_address_rates_the_file_inside_it(self, root):
        (root / "sub").mkdir()
        p = _webp(root / "sub")
        resp = _post(_body(subfolder="sub", rating=5))
        assert resp.status == 200
        assert xmp_meta.read_rating(str(p)) == 5


class TestRatingEndpointRejections:
    def test_a_body_that_is_not_json_is_a_400_and_writes_nothing(self, root):
        p = _webp(root)
        resp = _post(raises=True)
        assert resp.status == 400
        assert resp._body == {"ok": False, "error": "invalid json"}
        assert not _sidecar(p).exists()

        # Paired acceptance: the same file, a parseable body.
        assert _post(_body(rating=4)).status == 200
        assert _sidecar(p).exists()

    @pytest.mark.parametrize(
        ("rating", "accepted"),
        [(6, 5), (-1, 0), (True, 1), ("3", 3), (2.0, 2), (None, 1)],
    )
    def test_the_validator_message_is_the_400_body(self, root, rating, accepted):
        # Each refused value sits next to the accepted value it most resembles
        # — out of range beside the bound, bool beside its int, the string and
        # float beside the int they spell.
        p = _webp(root)
        resp = _post(_body(rating=rating))
        assert resp.status == 400
        assert resp._body == {"ok": False, "error": "rating must be an integer 0..5"}
        assert not _sidecar(p).exists()

        resp = _post(_body(rating=accepted))
        assert resp.status == 200
        assert xmp_meta.read_rating(str(p)) == accepted

    def test_an_address_error_is_passed_through_too(self, root):
        # A validator rejection that is not about the rating: the handler must
        # forward the ADDRESS validator's message, not a generic one.
        _webp(root)
        resp = _post(_body(name="../a.webp"))
        assert resp.status == 400
        assert resp._body == {"ok": False, "error": "invalid name"}

    def test_a_missing_file_is_a_404_not_a_400_and_creates_no_sidecar(self, root):
        # The resolver's status ladder: an address that is well-formed and
        # contained but names nothing is "not found", distinct from the 400 a
        # malformed address gets. Asserting the sidecar's absence is the point
        # — a write that ran anyway would CREATE gone.webp.xmp.
        resp = _post(_body(name="gone.webp"))
        assert resp.status == 404
        assert resp._body == {"ok": False, "error": "file not found"}
        assert not (root / "gone.webp.xmp").exists()

        _webp(root, "gone.webp")
        assert _post(_body(name="gone.webp")).status == 200

    def test_a_non_sandboxed_type_is_a_400_from_the_resolver(self, root):
        p = _webp(root)
        resp = _post(_body(type="models"))
        assert resp.status == 400
        assert resp._body == {
            "ok": False,
            "error": "writes are only allowed in input/output/temp",
        }
        assert not _sidecar(p).exists()

        assert _post(_body(type="temp")).status == 200

    def test_a_write_the_writer_refuses_is_a_500_carrying_its_reason(self, root):
        # A sidecar the writer will not parse (a DOCTYPE, which the XMP reader
        # refuses for entity-expansion safety) is refused rather than
        # overwritten — read-modify-write never clobbers what it cannot read.
        # The handler must surface that as a failure, not report ok.
        p = _webp(root)
        refused = b'<?xml version="1.0"?><!DOCTYPE x [<!ENTITY e "y">]><x>&e;</x>'
        _sidecar(p).write_bytes(refused)
        resp = _post(_body(rating=4))
        assert resp.status == 500
        assert resp._body == {
            "ok": False,
            "error": "existing XMP sidecar could not be updated safely",
        }
        assert _sidecar(p).read_bytes() == refused

        # Paired acceptance: the same file once the sidecar is one it can read.
        _sidecar(p).unlink()
        resp = _post(_body(rating=4))
        assert resp.status == 200
        assert xmp_meta.read_rating(str(p)) == 4
