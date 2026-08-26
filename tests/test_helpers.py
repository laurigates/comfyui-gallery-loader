"""Unit tests for pure helpers in gallery_loader.py.

Heavy and ComfyUI-internal imports are stubbed by conftest.py, so this
module can run in a vanilla Python environment.
"""

import asyncio
import os
from types import SimpleNamespace

import gallery_loader

# ---------- _parse_extensions ----------------------------------------


def test_parse_extensions_default_is_image_set():
    assert gallery_loader._parse_extensions("") == gallery_loader.IMG_EXTS


def test_parse_extensions_csv_with_dots():
    assert gallery_loader._parse_extensions(".mp4,.webm") == {".mp4", ".webm"}


def test_parse_extensions_csv_without_dots():
    assert gallery_loader._parse_extensions("png,jpg") == {".png", ".jpg"}


def test_parse_extensions_mixed_case_and_whitespace():
    assert gallery_loader._parse_extensions(" .PNG , JPG , ") == {".png", ".jpg"}


def test_parse_extensions_empty_tokens_fall_back_to_default():
    # All-whitespace tokens should leave the set empty, which falls
    # back to IMG_EXTS so the listing endpoint stays useful.
    assert gallery_loader._parse_extensions(", ,") == gallery_loader.IMG_EXTS


# ---------- _is_image_file ------------------------------------------


def test_is_image_file_recognizes_common_extensions():
    for name in ("foo.png", "Foo.PNG", "/a/b/c.webp", "x.tiff", "x.tif"):
        assert gallery_loader._is_image_file(name), name


def test_is_image_file_rejects_non_images():
    for name in ("foo.mp4", "foo", "", "video.webm", "doc.pdf"):
        assert not gallery_loader._is_image_file(name), name


# ---------- extension whitelists ------------------------------------


def test_streamable_exts_covers_images_and_video():
    assert ".png" in gallery_loader.STREAMABLE_EXTS
    assert ".mp4" in gallery_loader.STREAMABLE_EXTS
    assert ".webm" in gallery_loader.STREAMABLE_EXTS
    # Common non-media should NOT be in the whitelist.
    assert ".txt" not in gallery_loader.STREAMABLE_EXTS
    assert ".py" not in gallery_loader.STREAMABLE_EXTS


def test_img_and_video_sets_are_disjoint():
    assert not (gallery_loader.IMG_EXTS & gallery_loader.VIDEO_EXTS)


# ---------- audio whitelist (issue #88) ------------------------------
#
# Every assertion below is TWO-SIDED on purpose: an implementation that
# returned the empty set, or one that made every extension a member, passes
# a one-directional check and would ship a picker that lists nothing (or one
# that streams anything off an arbitrary path). Each test names an extension
# that must be in and one that must be out, of the SAME set.


def test_audio_exts_carries_what_the_audio_loaders_ask_for():
    # VHS `audio_extensions` (mp3/wav/ogg), VHS_LoadAudio's
    # `vhs_path_extensions` (+m4a/flac), and the mimetype-audio extensions
    # core LoadAudio's own combo picks up via filter_files_content_types.
    for ext in (".mp3", ".wav", ".ogg", ".oga", ".opus", ".flac", ".m4a", ".aac"):
        assert ext in gallery_loader.AUDIO_EXTS, ext
    # The paired negative, so a set that swallowed everything cannot pass.
    for ext in (".png", ".mp4", ".txt", ".py", ".safetensors"):
        assert ext not in gallery_loader.AUDIO_EXTS, ext


def test_audio_is_disjoint_from_image_and_video():
    # thumbForFile dispatches on membership, so an extension in two sets would
    # make a card's kind depend on the order the branches happen to be in.
    # `.mp4` is the live case: VHS_LoadAudioUpload offers it, and it stays a
    # VIDEO extension here.
    assert not (gallery_loader.AUDIO_EXTS & gallery_loader.IMG_EXTS)
    assert not (gallery_loader.AUDIO_EXTS & gallery_loader.VIDEO_EXTS)
    assert ".mp4" in gallery_loader.VIDEO_EXTS


def test_media_exts_admits_audio_so_the_list_clamp_does_not_drop_it():
    # /list intersects the requested extensions with MEDIA_EXTS. Audio missing
    # from it means an audio picker gets an empty grid and no error to read.
    assert ".flac" in gallery_loader.MEDIA_EXTS
    assert ".txt" not in gallery_loader.MEDIA_EXTS


def test_streamable_exts_admits_audio_so_path_mode_can_serve_it():
    # /gallery_loader/file is the only way a type=path listing reaches a file
    # that is not under input/output/temp. Narrow by design — the negative half
    # is the point of the assertion, not decoration.
    assert ".flac" in gallery_loader.STREAMABLE_EXTS
    assert ".m4a" in gallery_loader.STREAMABLE_EXTS
    assert ".txt" not in gallery_loader.STREAMABLE_EXTS
    assert ".safetensors" not in gallery_loader.STREAMABLE_EXTS


# ---------- _resolve_listing_base -----------------------------------


def test_resolve_listing_base_rejects_unknown_type():
    base, err = gallery_loader._resolve_listing_base("badtype", "", "")
    assert base is None
    assert "unknown type" in err


def test_resolve_listing_base_requires_path_for_path_type():
    base, err = gallery_loader._resolve_listing_base("path", "", "")
    assert base is None
    assert "missing path" in err


def test_resolve_listing_base_normalizes_path_type():
    base, err = gallery_loader._resolve_listing_base("path", "", "/tmp/../tmp/x")
    assert err == ""
    assert base == "/tmp/x"


# ---------- _validate_rating_request --------------------------------


def test_validate_rating_request_accepts_well_formed():
    parsed, err = gallery_loader._validate_rating_request(
        {"type": "output", "subfolder": "sub", "name": "foo.png", "rating": 3}
    )
    assert err == ""
    assert parsed == {
        "type": "output",
        "subfolder": "sub",
        "path": "",
        "name": "foo.png",
        "rating": 3,
    }


def test_validate_rating_request_rejects_out_of_range():
    for bad in (-1, 6, 99):
        parsed, err = gallery_loader._validate_rating_request({"name": "a.png", "rating": bad})
        assert parsed is None
        assert "0..5" in err


def test_validate_rating_request_rejects_non_int_rating():
    # bool is an int subclass — must be rejected too.
    for bad in (True, 2.5, "3", None):
        parsed, err = gallery_loader._validate_rating_request({"name": "a.png", "rating": bad})
        assert parsed is None
        assert "0..5" in err


def test_validate_rating_request_rejects_name_with_separators():
    for bad in ("../etc/passwd", "sub/foo.png", "..", ".", ""):
        parsed, err = gallery_loader._validate_rating_request({"name": bad, "rating": 1})
        assert parsed is None
        assert "invalid name" in err


def test_validate_rating_request_enforces_extension_whitelist():
    parsed, err = gallery_loader._validate_rating_request({"name": "evil.txt", "rating": 1})
    assert parsed is None
    assert "unsupported file type" in err
    # An allowed video extension passes the gate.
    parsed, err = gallery_loader._validate_rating_request({"name": "clip.mp4", "rating": 1})
    assert err == ""
    assert parsed is not None


def test_validate_rating_request_accepts_audio_because_audio_cards_show_stars():
    # The grid paints stars on every non-directory card, audio included, so a
    # gate that refused audio would ship a control that always fails. Paired
    # with the refusal below so a gate hard-wired to accept cannot pass either.
    parsed, err = gallery_loader._validate_rating_request({"name": "take.flac", "rating": 4})
    assert err == ""
    assert parsed is not None
    parsed, err = gallery_loader._validate_rating_request({"name": "notes.txt", "rating": 4})
    assert parsed is None
    assert "unsupported file type" in err


# ---------- /list recursive (flat) view -------------------------------


class _FakeGetRequest:
    """Stand-in for a GET aiohttp.web.Request — /list reads .rel_url.query."""

    def __init__(self, query):
        self.rel_url = SimpleNamespace(query=query)


class _ListEndpointBase:
    """Shared driver for the /list endpoint tests.

    Leading underscore so pytest does not collect it — subclassing a Test*
    class would re-run every inherited test once per subclass.

    conftest stubs web.json_response into a SimpleNamespace carrying the body,
    which is what makes these endpoint-level assertions possible at all.

    NOTE: PIL is stubbed with MagicMocks, so the width/height probe inside
    _scan_file_entry raises and dimensions come back None. Don't assert on
    them here — that is a harness limit, not a contract.
    """

    def _call(self, query):
        return asyncio.run(gallery_loader.gallery_list(_FakeGetRequest(query)))

    def _sandbox(self, base, monkeypatch):
        import folder_paths

        monkeypatch.setattr(
            folder_paths, "get_directory_by_type", lambda t: str(base), raising=False
        )


class TestListRecursive(_ListEndpointBase):
    """Flat (recursive) listing."""

    def test_recursive_lists_descendants_with_subpath(self, tmp_path, monkeypatch):
        self._sandbox(tmp_path, monkeypatch)
        (tmp_path / "top.png").write_bytes(b"x")
        deep = tmp_path / "sub" / "deep"
        deep.mkdir(parents=True)
        (deep / "nested.png").write_bytes(b"x")
        resp = self._call({"type": "output", "subfolder": "", "recursive": "1"})
        assert resp._body["ok"] is True
        # Flat view returns files only — no folder cards.
        assert resp._body["dirs"] == []
        assert resp._body["truncated"] is False
        by_name = {f["name"]: f for f in resp._body["files"]}
        assert by_name["top.png"]["subpath"] == ""
        assert by_name["nested.png"]["subpath"] == "sub/deep"

    def test_subpath_is_relative_to_the_requested_subfolder(self, tmp_path, monkeypatch):
        # Flattening a SUBTREE, not the whole root: subpath is relative to the
        # requested subfolder, which is what the frontend joins onto it.
        self._sandbox(tmp_path, monkeypatch)
        deep = tmp_path / "run" / "a" / "b"
        deep.mkdir(parents=True)
        (deep / "nested.png").write_bytes(b"x")
        resp = self._call({"type": "output", "subfolder": "run", "recursive": "1"})
        by_name = {f["name"]: f for f in resp._body["files"]}
        assert by_name["nested.png"]["subpath"] == "a/b"

    def test_non_recursive_is_single_level_without_subpath(self, tmp_path, monkeypatch):
        self._sandbox(tmp_path, monkeypatch)
        (tmp_path / "top.png").write_bytes(b"x")
        (tmp_path / "sub").mkdir()
        (tmp_path / "sub" / "nested.png").write_bytes(b"x")
        resp = self._call({"type": "output", "subfolder": ""})
        names = {f["name"] for f in resp._body["files"]}
        assert names == {"top.png"}  # the nested file is not surfaced
        # The KEY must be absent, not "" — the frontend distinguishes "flat
        # listing, top-level file" from "folder listing" by its presence.
        assert "subpath" not in resp._body["files"][0]
        assert [d["name"] for d in resp._body["dirs"]] == ["sub"]

    def test_recursive_prunes_hidden_and_pycache(self, tmp_path, monkeypatch):
        self._sandbox(tmp_path, monkeypatch)
        (tmp_path / "keep.png").write_bytes(b"x")
        (tmp_path / ".hidden.png").write_bytes(b"x")
        cache = tmp_path / "__pycache__"
        cache.mkdir()
        (cache / "junk.png").write_bytes(b"x")
        clip = tmp_path / "clipspace"
        clip.mkdir()
        (clip / "scratch.png").write_bytes(b"x")
        resp = self._call({"type": "output", "subfolder": "", "recursive": "1"})
        names = {f["name"] for f in resp._body["files"]}
        assert names == {"keep.png"}

    def test_recursive_does_not_follow_symlinked_dir(self, tmp_path, monkeypatch):
        # The security case: follow_symlinks=False on every probe is what keeps
        # the walk inside the sandbox root.
        base = tmp_path / "root"
        base.mkdir()
        self._sandbox(base, monkeypatch)
        outside = tmp_path / "outside"  # sibling of base — reachable only via the link
        outside.mkdir()
        (outside / "secret.png").write_bytes(b"x")
        inner = base / "inner"
        inner.mkdir()
        (inner / "link").symlink_to(outside, target_is_directory=True)
        resp = self._call({"type": "output", "subfolder": "", "recursive": "1"})
        names = {f["name"] for f in resp._body["files"]}
        assert "secret.png" not in names

    def test_recursive_ignored_for_path_type(self, tmp_path, monkeypatch):
        # recursive is a sandboxed-root affordance; type=path stays single-level.
        (tmp_path / "top.png").write_bytes(b"x")
        (tmp_path / "sub").mkdir()
        (tmp_path / "sub" / "nested.png").write_bytes(b"x")
        resp = self._call({"type": "path", "path": str(tmp_path), "recursive": "1"})
        names = {f["name"] for f in resp._body["files"]}
        assert names == {"top.png"}
        assert [d["name"] for d in resp._body["dirs"]] == ["sub"]

    def test_recursive_truncates_at_cap(self, tmp_path, monkeypatch):
        self._sandbox(tmp_path, monkeypatch)
        monkeypatch.setattr(gallery_loader, "FLAT_LIST_CAP", 3)
        for i in range(5):
            (tmp_path / f"f{i}.png").write_bytes(b"x")
        resp = self._call({"type": "output", "subfolder": "", "recursive": "1"})
        assert resp._body["truncated"] is True
        assert len(resp._body["files"]) == 3

    def test_truncation_keeps_the_newest_not_the_first_walked(self, tmp_path, monkeypatch):
        """The cap must bite by mtime, not by directory-walk order.

        The walk descends alphabetically, so a cap applied DURING the walk would
        return a/ and b/ and never reach z/ — silently hiding the newest file,
        which is the one thing the flat view exists to surface. This test fails
        against any "optimization" that caps during enumeration.
        """
        self._sandbox(tmp_path, monkeypatch)
        monkeypatch.setattr(gallery_loader, "FLAT_LIST_CAP", 2)
        for folder, name, mtime in (
            ("a", "oldest.png", 1000),
            ("b", "middle.png", 2000),
            ("z", "newest.png", 3000),
        ):
            d = tmp_path / folder
            d.mkdir()
            f = d / name
            f.write_bytes(b"x")
            os.utime(f, (mtime, mtime))

        resp = self._call({"type": "output", "subfolder": "", "recursive": "1"})
        assert resp._body["truncated"] is True
        names = {f["name"] for f in resp._body["files"]}
        assert names == {"newest.png", "middle.png"}
        assert "oldest.png" not in names
        by_name = {f["name"]: f for f in resp._body["files"]}
        assert by_name["newest.png"]["subpath"] == "z"

    def test_probes_run_only_on_files_that_ship(self, tmp_path, monkeypatch):
        """Sorting before probing is what keeps a truncated walk cheap.

        _scan_file_entry opens each file twice (PIL header + XMP rating). Under
        a cap it must run cap times, not once per file in the subtree. This is
        also the test that proves the extraction happened — it cannot be
        written against an inlined loop.
        """
        self._sandbox(tmp_path, monkeypatch)
        monkeypatch.setattr(gallery_loader, "FLAT_LIST_CAP", 2)
        probed: list[str] = []
        real = gallery_loader._scan_file_entry

        def counting(path, name, ext, st, image_subset):
            probed.append(name)
            return real(path, name, ext, st, image_subset)

        monkeypatch.setattr(gallery_loader, "_scan_file_entry", counting)
        for i in range(6):
            f = tmp_path / f"f{i}.png"
            f.write_bytes(b"x")
            os.utime(f, (1000 + i, 1000 + i))

        resp = self._call({"type": "output", "subfolder": "", "recursive": "1"})
        assert len(resp._body["files"]) == 2
        # Six files enumerated, two probed — and they are the two newest.
        assert sorted(probed) == ["f4.png", "f5.png"]

    def test_enumeration_backstop_marks_truncated(self, tmp_path, monkeypatch):
        """FLAT_WALK_CAP bounds the cheap pass; hitting it drops the newest-N
        guarantee, so the response must still say truncated."""
        self._sandbox(tmp_path, monkeypatch)
        monkeypatch.setattr(gallery_loader, "FLAT_WALK_CAP", 2)
        monkeypatch.setattr(gallery_loader, "FLAT_LIST_CAP", 100)
        for i in range(5):
            (tmp_path / f"f{i}.png").write_bytes(b"x")
        resp = self._call({"type": "output", "subfolder": "", "recursive": "1"})
        assert resp._body["truncated"] is True
        assert len(resp._body["files"]) == 2


class TestListCapsAndClamps(_ListEndpointBase):
    """Caps and the extension clamp on the NON-recursive path."""

    def test_truncated_is_present_even_when_the_directory_is_missing(self, tmp_path, monkeypatch):
        # An intermittently-present boolean reads as `undefined` and happens to
        # work, until someone writes `data.truncated === false`.
        self._sandbox(tmp_path / "nope", monkeypatch)
        resp = self._call({"type": "output", "subfolder": ""})
        assert resp._body["exists"] is False
        assert resp._body["truncated"] is False

    def test_non_recursive_caps_at_dir_list_cap_by_mtime(self, tmp_path, monkeypatch):
        self._sandbox(tmp_path, monkeypatch)
        monkeypatch.setattr(gallery_loader, "DIR_LIST_CAP", 2)
        for i in range(5):
            f = tmp_path / f"f{i}.png"
            f.write_bytes(b"x")
            os.utime(f, (1000 + i, 1000 + i))
        resp = self._call({"type": "output", "subfolder": ""})
        assert resp._body["truncated"] is True
        assert {f["name"] for f in resp._body["files"]} == {"f3.png", "f4.png"}

    def test_audio_survives_the_clamp_while_a_non_media_file_does_not(self, tmp_path, monkeypatch):
        """End-to-end for the AUDIO_EXTS widening (issue #88).

        Two-sided in ONE request: the same call asks for an audio extension and
        a non-media one. A clamp that dropped audio returns [] and a clamp that
        passed everything through returns both, so neither degenerate
        implementation can produce this result.
        """
        self._sandbox(tmp_path, monkeypatch)
        (tmp_path / "take.flac").write_bytes(b"x")
        (tmp_path / "notes.txt").write_bytes(b"x")
        resp = self._call({"type": "output", "subfolder": "", "extensions": ".flac,.txt"})
        assert {f["name"] for f in resp._body["files"]} == {"take.flac"}

    def test_extensions_are_clamped_to_media(self, tmp_path, monkeypatch):
        # Recursion turns a directory-at-a-time enumeration into a whole-tree
        # one; asking for .txt must not enumerate the tree's non-media files.
        self._sandbox(tmp_path, monkeypatch)
        (tmp_path / "notes.txt").write_bytes(b"x")
        (tmp_path / "keep.png").write_bytes(b"x")
        resp = self._call({"type": "output", "subfolder": "", "extensions": ".txt"})
        assert resp._body["files"] == []
        resp = self._call({"type": "output", "subfolder": "", "extensions": ".txt,.png"})
        assert {f["name"] for f in resp._body["files"]} == {"keep.png"}

    def test_directory_mode_sentinel_still_lists_nothing(self, tmp_path, monkeypatch):
        """Regression guard for the clamp's placement.

        Directory mode passes `.__none__` to get a files-free listing. The clamp
        must stay in the handler: moving it inside _parse_extensions would hit
        that helper's `or IMG_EXTS` fallback, re-expand the empty intersection,
        and silently list every image here.
        """
        self._sandbox(tmp_path, monkeypatch)
        (tmp_path / "img.png").write_bytes(b"x")
        (tmp_path / "sub").mkdir()
        resp = self._call({"type": "output", "subfolder": "", "extensions": ".__none__"})
        assert resp._body["files"] == []
        assert [d["name"] for d in resp._body["dirs"]] == ["sub"]

    def test_recursive_with_no_usable_extensions_does_not_walk(self, tmp_path, monkeypatch):
        # Walking a whole tree to return nothing is pure waste.
        self._sandbox(tmp_path, monkeypatch)
        (tmp_path / "sub").mkdir()
        (tmp_path / "sub" / "img.png").write_bytes(b"x")
        resp = self._call(
            {"type": "output", "subfolder": "", "extensions": ".__none__", "recursive": "1"}
        )
        assert resp._body["files"] == []
        # Fell back to the folder listing, so dirs are still present.
        assert [d["name"] for d in resp._body["dirs"]] == ["sub"]
