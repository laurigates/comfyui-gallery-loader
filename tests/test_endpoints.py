"""Endpoint-level tests for the non-JSON HTTP handlers.

`tests/test_helpers.py` drives `/list` because conftest stubs
`web.json_response` into something with an inspectable body. `/thumb` and
`/file` answer with `web.Response` / `web.FileResponse`, which were bare
MagicMocks until conftest gained `_stub_response` / `_stub_file_response` —
so their status ladder, extension whitelist and conditional-request logic had
no coverage at all. That is the gap #14 was filed for.

Two things every test here holds to:

* **Both directions on the same input.** A lone negative ("a .txt is
  refused") passes just as happily against a handler wired to refuse
  everything, so each rejection is paired with the acceptance of a file that
  differs only in the thing under test.
* **Real bytes on disk.** The handlers stat and read; `tmp_path` files are
  cheaper than mocking `os.stat` and cannot drift from what the code does.

PIL is stubbed by conftest, so `thumb_cache.encode_thumb` is monkeypatched to
fixed bytes — the encode itself is `tests/test_thumb.py`'s subject, not this
module's.
"""

from __future__ import annotations

import asyncio
import os

import folder_paths  # the conftest stub

import gallery_loader
import thumb_cache

THUMB_BYTES = b"RIFF-fake-webp"


def _call(handler, request):
    return asyncio.run(handler(request))


def _file(get_request, path):
    """GET /gallery_loader/file?path=<path>."""
    return _call(gallery_loader.gallery_file, get_request({"path": str(path)}))


# ---------- /gallery_loader/base -------------------------------------


def test_base_reports_the_well_known_dirs(get_request, monkeypatch):
    monkeypatch.setattr(folder_paths, "base_path", "/comfy", raising=False)
    for attr, value in (
        ("get_input_directory", "/comfy/input"),
        ("get_output_directory", "/comfy/output"),
        ("get_temp_directory", "/comfy/temp"),
        ("get_user_directory", "/comfy/user"),
    ):
        monkeypatch.setattr(folder_paths, attr, lambda v=value: v, raising=False)

    resp = _call(gallery_loader.gallery_base, get_request())

    assert resp.status == 200
    assert resp._body == {
        "ok": True,
        "base_path": "/comfy",
        "input_dir": "/comfy/input",
        "output_dir": "/comfy/output",
        "temp_dir": "/comfy/temp",
        "user_dir": "/comfy/user",
    }


# ---------- /gallery_loader/file — the status ladder ------------------


class TestFileEndpoint:
    """`/file` is an arbitrary absolute-path read behind an extension gate."""

    def test_empty_path_is_400_and_a_real_path_is_not(self, tmp_path, get_request):
        png = tmp_path / "a.png"
        png.write_bytes(b"x")

        assert _call(gallery_loader.gallery_file, get_request({})).status == 400
        assert _call(gallery_loader.gallery_file, get_request({"path": ""})).status == 400
        # Paired positive: the only difference is that the path is non-empty.
        ok = _file(get_request, png)
        assert ok.status == 200

    def test_missing_file_is_404_and_the_same_name_present_is_not(self, tmp_path, get_request):
        missing = tmp_path / "gone.png"
        assert _file(get_request, missing).status == 404

        missing.write_bytes(b"x")  # same path, now on disk
        assert _file(get_request, missing).status == 200

    def test_extension_whitelist_refuses_403_but_admits_media(self, tmp_path, get_request):
        # Same directory, same bytes, same everything but the extension — so a
        # handler that refused unconditionally fails the second half.
        blocked = tmp_path / "secrets.txt"
        blocked.write_bytes(b"x")
        assert _file(get_request, blocked).status == 403

        for name in ("a.png", "clip.mp4", "clip.webm"):
            f = tmp_path / name
            f.write_bytes(b"x")
            resp = _file(get_request, f)
            assert resp.status == 200, name
            assert resp.path == str(f), name

    def test_a_directory_is_404_not_streamed(self, tmp_path, get_request):
        # os.path.isfile, not os.path.exists: a directory named *.png would
        # otherwise reach FileResponse.
        d = tmp_path / "trap.png"
        d.mkdir()
        assert _file(get_request, d).status == 404

    def test_a_served_file_carries_its_mime_type_and_a_cache_window(self, tmp_path, get_request):
        png = tmp_path / "a.png"
        png.write_bytes(b"x")
        mp4 = tmp_path / "clip.mp4"
        mp4.write_bytes(b"x")

        img = _file(get_request, png)
        vid = _file(get_request, mp4)

        # Two extensions, two different types — a hardcoded content type would
        # pass a single-file assertion.
        assert img.headers["Content-Type"] == "image/png"
        assert vid.headers["Content-Type"] == "video/mp4"
        assert "max-age=300" in img.headers["Cache-Control"]

    def test_the_path_is_normalised_before_the_isfile_probe(self, tmp_path, get_request):
        png = tmp_path / "sub" / "a.png"
        png.parent.mkdir()
        png.write_bytes(b"x")
        traversal = str(tmp_path / "sub" / ".." / "sub" / "a.png")

        resp = _file(get_request, traversal)

        assert resp.status == 200
        # The response addresses the resolved path, not the string handed in.
        assert resp.path == str(png)


# ---------- /gallery_loader/thumb -------------------------------------


class TestThumbEndpoint:
    """`/thumb` is `/file`'s image-only sibling, plus HTTP caching."""

    def _setup(self, tmp_path, monkeypatch):
        monkeypatch.setattr(
            folder_paths, "get_user_directory", lambda: str(tmp_path / "user"), raising=False
        )
        monkeypatch.setattr(thumb_cache, "encode_thumb", lambda _p: THUMB_BYTES)

    def _get(self, get_request, query, headers=None):
        return _call(gallery_loader.gallery_thumb, get_request(query, headers))

    def _etag(self, get_request, png):
        return self._get(get_request, {"path": str(png)}).headers["ETag"]

    def _png(self, tmp_path, name="a.png", data=b"x"):
        f = tmp_path / name
        f.write_bytes(data)
        return f

    def test_a_200_carries_the_bytes_and_all_three_cache_headers(
        self, tmp_path, monkeypatch, get_request
    ):
        self._setup(tmp_path, monkeypatch)
        png = self._png(tmp_path)

        resp = self._get(get_request, {"path": str(png)})

        assert resp.status == 200
        assert resp.body == THUMB_BYTES
        assert resp.content_type == "image/webp"
        assert resp.headers["ETag"] == thumb_cache.etag_for(str(png), os.stat(png))
        assert "max-age=604800" in resp.headers["Cache-Control"]
        assert resp.headers["Last-Modified"].endswith("GMT")

    def test_the_etag_is_stable_while_the_file_is_untouched(
        self, tmp_path, monkeypatch, get_request
    ):
        self._setup(tmp_path, monkeypatch)
        png = self._png(tmp_path)

        first = self._get(get_request, {"path": str(png)})
        second = self._get(get_request, {"path": str(png)})

        assert first.headers["ETag"] == second.headers["ETag"]

    def test_a_matching_if_none_match_is_a_304_with_no_body(
        self, tmp_path, monkeypatch, get_request
    ):
        self._setup(tmp_path, monkeypatch)
        png = self._png(tmp_path)
        etag = self._etag(get_request, png)

        hit = self._get(get_request, {"path": str(png)}, {"If-None-Match": etag})
        # Paired positive: a stale validator must still get the bytes, so this
        # cannot pass against a handler that answers 304 unconditionally.
        miss = self._get(get_request, {"path": str(png)}, {"If-None-Match": '"stale"'})

        assert hit.status == 304
        assert hit.body is None
        # The revalidation headers must ride the 304 too — without them the
        # browser has nothing to revalidate against on the next request.
        assert hit.headers["ETag"] == etag
        assert "max-age=604800" in hit.headers["Cache-Control"]
        assert miss.status == 200
        assert miss.body == THUMB_BYTES

    def test_the_etag_changes_when_the_mtime_moves(self, tmp_path, monkeypatch, get_request):
        self._setup(tmp_path, monkeypatch)
        png = self._png(tmp_path)
        before = self._etag(get_request, png)

        os.utime(png, (1_000_000, 1_000_000))
        after = self._etag(get_request, png)

        assert after != before
        # And the client's now-stale validator no longer short-circuits.
        stale = self._get(get_request, {"path": str(png)}, {"If-None-Match": before})
        assert stale.status == 200

    def test_the_etag_changes_when_only_the_size_does(self, tmp_path, monkeypatch, get_request):
        # mtime held constant on purpose: size is the variable, so this fails
        # against a key built from the path and mtime alone.
        self._setup(tmp_path, monkeypatch)
        png = self._png(tmp_path, data=b"x")
        os.utime(png, (1_000_000, 1_000_000))
        before = self._etag(get_request, png)

        png.write_bytes(b"xxxxxxxx")
        os.utime(png, (1_000_000, 1_000_000))
        after = self._etag(get_request, png)

        assert os.stat(png).st_mtime_ns == 1_000_000_000_000_000
        assert after != before

    def test_empty_path_is_400_and_a_real_path_is_not(self, tmp_path, monkeypatch, get_request):
        self._setup(tmp_path, monkeypatch)
        png = self._png(tmp_path)

        assert self._get(get_request, {}).status == 400
        assert self._get(get_request, {"path": ""}).status == 400
        assert self._get(get_request, {"path": str(png)}).status == 200

    def test_missing_file_is_404_and_the_same_name_present_is_not(
        self, tmp_path, monkeypatch, get_request
    ):
        self._setup(tmp_path, monkeypatch)
        missing = tmp_path / "gone.png"
        assert self._get(get_request, {"path": str(missing)}).status == 404

        missing.write_bytes(b"x")
        assert self._get(get_request, {"path": str(missing)}).status == 200

    def test_a_non_image_extension_is_refused_404_while_an_image_is_served(
        self, tmp_path, monkeypatch, get_request
    ):
        # NOTE the status differs from /file's 403 for the same class of
        # rejection: /thumb folds "not on disk" and "not an image" into one
        # `os.path.isfile(path) or _is_image_file(path)` guard. Pinning the
        # observed behaviour rather than the symmetry #14 assumed — a video is
        # refused here too, which is correct (there is no still to encode) and
        # is why the picker asks /file for video posters.
        self._setup(tmp_path, monkeypatch)
        for name in ("secrets.txt", "clip.mp4", "notes.md"):
            f = tmp_path / name
            f.write_bytes(b"x")
            resp = self._get(get_request, {"path": str(f)})
            assert resp.status == 404, name

        png = self._png(tmp_path)
        assert self._get(get_request, {"path": str(png)}).status == 200

    def test_sandboxed_mode_serves_a_bare_name_and_refuses_one_that_escapes(
        self, tmp_path, monkeypatch, get_request
    ):
        self._setup(tmp_path, monkeypatch)
        root = tmp_path / "output"
        root.mkdir()
        (root / "a.png").write_bytes(b"x")
        outside = tmp_path / "outside.png"
        outside.write_bytes(b"x")
        monkeypatch.setattr(
            folder_paths, "get_directory_by_type", lambda _t: str(root), raising=False
        )

        served = self._get(get_request, {"type": "output", "subfolder": "", "name": "a.png"})
        escaped = self._get(
            get_request, {"type": "output", "subfolder": "", "name": "../outside.png"}
        )

        assert served.status == 200
        assert served.body == THUMB_BYTES
        # 400, not 404: the name never resolves to a target at all. The file it
        # points at DOES exist, so a 404 here would be indistinguishable from
        # the traversal having simply missed.
        assert escaped.status == 400

    def test_a_500_is_reported_when_the_encode_yields_nothing(
        self, tmp_path, monkeypatch, get_request
    ):
        # The one status the resolver cannot produce. Paired with a working
        # encoder over the same file so this cannot pass against a handler
        # that always 500s.
        self._setup(tmp_path, monkeypatch)
        png = self._png(tmp_path)
        assert self._get(get_request, {"path": str(png)}).status == 200

        monkeypatch.setattr(thumb_cache, "encode_thumb", lambda _p: None)
        monkeypatch.setattr(
            folder_paths, "get_user_directory", lambda: str(tmp_path / "user2"), raising=False
        )
        assert self._get(get_request, {"path": str(png)}).status == 500
