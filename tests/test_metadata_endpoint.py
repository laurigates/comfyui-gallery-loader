"""Contract tests for /gallery_loader/metadata.

Scope is deliberately the ENDPOINT, not the parser. image_meta.py is vendored
verbatim from comfyui-image-browser, which owns its exhaustive
attacker-shaped-input suite (tests/test_metadata.py there); duplicating it here
would just be a second copy to keep in sync. What this file locks is the part
that is ours: addressing, the extension gate and its ordering, and the response
shape.
"""

from __future__ import annotations

import asyncio
import struct
import zlib
from types import SimpleNamespace

import gallery_loader


class _FakeGetRequest:
    def __init__(self, query):
        self.rel_url = SimpleNamespace(query=query)


def _chunk(kind: bytes, data: bytes) -> bytes:
    return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data))


def _png(text: dict[bytes, bytes] | None = None) -> bytes:
    """A minimal but structurally valid PNG, optionally carrying tEXt chunks."""
    out = b"\x89PNG\r\n\x1a\n"
    out += _chunk(b"IHDR", struct.pack(">IIBBBBB", 1, 1, 8, 2, 0, 0, 0))
    for k, v in (text or {}).items():
        out += _chunk(b"tEXt", k + b"\x00" + v)
    out += _chunk(b"IEND", b"")
    return out


def _call(query):
    return asyncio.run(gallery_loader.gallery_metadata(_FakeGetRequest(query)))


class TestMetadataEndpoint:
    def test_reads_an_a1111_block(self, tmp_path):
        f = tmp_path / "shot.png"
        f.write_bytes(
            _png({b"parameters": b"a cat\nNegative prompt: blurry\nSteps: 20, CFG scale: 7.5"})
        )
        resp = _call({"type": "path", "path": str(f)})
        assert resp.status == 200
        body = resp._body
        assert body["ok"] is True
        assert body["format"] == "png"
        assert body["source"] == "a1111"
        assert body["summary"]["positive"] == "a cat"
        assert body["summary"]["negative"] == "blurry"
        assert body["raw"]["parameters"].startswith("a cat")

    def test_image_without_embedded_text_is_a_clean_empty_read(self, tmp_path):
        # "nothing embedded" is a 200 with source=none, never an error — the
        # frontend distinguishes it from a failure.
        f = tmp_path / "plain.png"
        f.write_bytes(_png())
        resp = _call({"type": "path", "path": str(f)})
        assert resp.status == 200
        assert resp._body["source"] == "none"
        assert resp._body["raw"] == {}
        assert resp._body["truncated"] is False

    def test_non_whitelisted_extension_is_400_not_404(self, tmp_path):
        # The gate is asserted BEFORE os.path.isfile, so a .txt that exists and
        # a .txt that doesn't both answer 400 — the extension is the objection,
        # and the caller learns nothing about what is on disk.
        present = tmp_path / "notes.txt"
        present.write_bytes(b"secret")
        assert _call({"type": "path", "path": str(present)}).status == 400
        assert _call({"type": "path", "path": str(tmp_path / "absent.txt")}).status == 400

    def test_video_is_rejected_even_though_other_endpoints_stream_it(self, tmp_path):
        # The gate is IMG_EXTS, not STREAMABLE_EXTS: no new extension enters
        # the read perimeter because of this endpoint.
        f = tmp_path / "clip.mp4"
        f.write_bytes(b"\x00" * 16)
        assert _call({"type": "path", "path": str(f)}).status == 400

    def test_missing_image_is_404(self, tmp_path):
        assert _call({"type": "path", "path": str(tmp_path / "gone.png")}).status == 404

    def test_rejects_a_traversing_name_on_a_sandboxed_root(self, tmp_path, monkeypatch):
        import folder_paths

        monkeypatch.setattr(
            folder_paths, "get_directory_by_type", lambda t: str(tmp_path), raising=False
        )
        resp = _call({"type": "output", "subfolder": "", "name": "../escape.png"})
        assert resp.status == 400
        assert resp._body["ok"] is False

    def test_resolves_a_sandboxed_address(self, tmp_path, monkeypatch):
        import folder_paths

        monkeypatch.setattr(
            folder_paths, "get_directory_by_type", lambda t: str(tmp_path), raising=False
        )
        sub = tmp_path / "run"
        sub.mkdir()
        (sub / "img.png").write_bytes(
            _png({b"parameters": b"hello\nNegative prompt: nope\nSteps: 8"})
        )
        resp = _call({"type": "output", "subfolder": "run", "name": "img.png"})
        assert resp.status == 200
        assert resp._body["summary"]["positive"] == "hello"

    def test_unparseable_container_still_answers_200(self, tmp_path):
        # A whitelisted extension whose bytes are junk must not 500 — every
        # input here is attacker-shaped and the reader never raises out.
        f = tmp_path / "junk.png"
        f.write_bytes(b"not a png at all")
        resp = _call({"type": "path", "path": str(f)})
        assert resp.status == 200
        assert resp._body["ok"] is True
        assert resp._body["source"] == "none"

    def test_whitelisted_image_with_no_parser_is_empty_not_an_error(self, tmp_path):
        # .gif is in IMG_EXTS but has no entry in FORMAT_EXTS, so format is ""
        # and the read short-circuits. It must still be a clean 200 — the
        # frontend shows "no generation data", not a failure toast.
        f = tmp_path / "anim.gif"
        f.write_bytes(b"GIF89a" + b"\x00" * 16)
        resp = _call({"type": "path", "path": str(f)})
        assert resp.status == 200
        assert resp._body["format"] == ""
        assert resp._body["source"] == "none"
        assert resp._body["raw"] == {}
