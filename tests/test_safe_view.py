"""Safe View — the server-side hide half of the family's sensitive-content filter.

The matcher here is a deliberate PORT of the frontend's, in
@laurigates/comfy-modal-kit `src/safe-view.ts`. The two must agree file-for-file:
the frontend blurs what IT thinks matches while this drops what IT thinks
matches, so a divergence surfaces as a file hidden in one pack and plain in the
other over the same bytes on disk. `comfyui-image-browser` carries the identical
port, pinned by the identical assertions.

The control cases below are the load-bearing ones. A SUBSTRING matcher passes
every positive test in this file — only `ass` vs `assets/` and `nsfw` vs
`nsfwish.png` tell the two apart, and a substring regression is invisible to the
user because a wrongly-hidden file looks exactly like a file that is not there.
"""

from __future__ import annotations

import asyncio
import os
from types import SimpleNamespace

import pytest

import gallery_loader

# ---------------------------------------------------------------------------
# Pure helpers
# ---------------------------------------------------------------------------


class TestSafeTokens:
    def test_splits_on_every_non_alphanumeric(self):
        assert gallery_loader._safe_tokens("output/nsfw/2026-08-04") == {
            "output",
            "nsfw",
            "2026",
            "08",
            "04",
        }

    def test_lowercases(self):
        assert gallery_loader._safe_tokens("NSFW") == {"nsfw"}

    def test_underscores_and_dots_are_separators(self):
        assert gallery_loader._safe_tokens("my_nsfw_pic.png") == {"my", "nsfw", "pic", "png"}

    def test_empty_input_yields_no_tokens(self):
        assert gallery_loader._safe_tokens("") == set()

    def test_leading_and_trailing_separators_produce_no_empty_token(self):
        assert gallery_loader._safe_tokens("/a/") == {"a"}


class TestParseSafeKeywords:
    def test_comma_separated(self):
        assert gallery_loader._parse_safe_keywords("nsfw,private") == ["nsfw", "private"]

    def test_whitespace_separated(self):
        assert gallery_loader._parse_safe_keywords("nsfw private") == ["nsfw", "private"]

    def test_mixed_separators_and_blanks(self):
        assert gallery_loader._parse_safe_keywords(" nsfw , ,  private ") == ["nsfw", "private"]

    def test_strips_punctuation_from_each_keyword(self):
        # A keyword carrying punctuation could never equal a token produced by
        # _safe_tokens, so it is normalised the same way rather than left to
        # silently match nothing.
        assert gallery_loader._parse_safe_keywords("n-s.f/w") == ["nsfw"]

    def test_dedupes_preserving_order(self):
        assert gallery_loader._parse_safe_keywords("b,a,b") == ["b", "a"]

    def test_empty_yields_empty_list(self):
        assert gallery_loader._parse_safe_keywords("") == []
        assert gallery_loader._parse_safe_keywords("   ") == []


class TestSafeJoin:
    def test_joins_non_empty_parts(self):
        assert gallery_loader._safe_join("output", "a/b") == "output/a/b"

    def test_drops_empty_parts(self):
        assert gallery_loader._safe_join("output", "") == "output"
        assert gallery_loader._safe_join("", "") == ""

    def test_strips_redundant_slashes(self):
        assert gallery_loader._safe_join("/output/", "/a/") == "output/a"


class TestIsSensitive:
    """Positive matches — a keyword found as a WHOLE token anywhere."""

    def test_matches_a_name_token(self):
        assert gallery_loader._is_sensitive("my_nsfw_pic.png", "", ["nsfw"]) is True

    def test_matches_a_folder_segment(self):
        assert gallery_loader._is_sensitive("a.png", "output/nsfw/2026-08-04", ["nsfw"]) is True

    def test_matches_the_root_segment(self):
        # The root is part of the logical address, so a keyword of `temp`
        # matches every file under the temp root. This is what makes the
        # frontend's `${root}/${subfolder}` and the backend's type_name +
        # subfolder the same haystack.
        assert gallery_loader._is_sensitive("a.png", "temp/renders", ["temp"]) is True

    def test_matches_case_insensitively(self):
        assert gallery_loader._is_sensitive("A_NSFW_B.png", "", ["nsfw"]) is True

    def test_any_keyword_matching_is_enough(self):
        assert gallery_loader._is_sensitive("holiday.png", "output/private", ["nsfw", "private"])

    def test_no_keywords_never_matches(self):
        assert gallery_loader._is_sensitive("nsfw.png", "output/nsfw", []) is False


class TestIsSensitiveControls:
    """The known-good controls. A substring matcher fails exactly these."""

    def test_short_keyword_does_not_match_a_longer_token_in_the_path(self):
        # `ass` is a substring of `assets` and must NOT match it.
        assert gallery_loader._is_sensitive("a.png", "input/assets", ["ass"]) is False

    def test_short_keyword_does_not_match_a_longer_token_in_the_name(self):
        assert gallery_loader._is_sensitive("classic.png", "", ["ass"]) is False

    def test_keyword_does_not_match_a_longer_token_it_prefixes(self):
        # `nsfw` is a prefix of `nsfwish` and must NOT match it.
        assert gallery_loader._is_sensitive("nsfwish.png", "", ["nsfw"]) is False

    def test_unrelated_file_is_not_matched(self):
        assert gallery_loader._is_sensitive("holiday.png", "output/2026", ["nsfw"]) is False

    def test_positive_control_so_a_never_matching_matcher_is_not_mistaken_for_correct(self):
        # Without this, a matcher hard-wired to return False would satisfy every
        # other case in this class.
        assert gallery_loader._is_sensitive("nsfw.png", "", ["nsfw"]) is True


# ---------------------------------------------------------------------------
# Endpoint
# ---------------------------------------------------------------------------


class _FakeGetRequest:
    def __init__(self, query):
        self.rel_url = SimpleNamespace(query=query)


class _Base:
    def _call(self, query):
        return asyncio.run(gallery_loader.gallery_list(_FakeGetRequest(query)))

    def _sandbox(self, base, monkeypatch):
        import folder_paths

        monkeypatch.setattr(
            folder_paths, "get_directory_by_type", lambda t: str(base), raising=False
        )

    def _names(self, resp):
        return {f["name"] for f in resp._body["files"]}


class TestListSafeHide(_Base):
    def test_hides_matching_files(self, tmp_path, monkeypatch):
        self._sandbox(tmp_path, monkeypatch)
        (tmp_path / "holiday.png").write_bytes(b"x")
        (tmp_path / "my_nsfw_pic.png").write_bytes(b"x")
        resp = self._call({"type": "output", "subfolder": "", "safe_kw": "nsfw", "safe_hide": "1"})
        assert self._names(resp) == {"holiday.png"}

    def test_hides_matching_directories_by_name(self, tmp_path, monkeypatch):
        # Otherwise an `nsfw/` card survives as a visible — and now empty —
        # doorway into the thing being hidden.
        self._sandbox(tmp_path, monkeypatch)
        (tmp_path / "nsfw").mkdir()
        (tmp_path / "holiday").mkdir()
        resp = self._call({"type": "output", "subfolder": "", "safe_kw": "nsfw", "safe_hide": "1"})
        assert [d["name"] for d in resp._body["dirs"]] == ["holiday"]

    def test_matches_the_logical_root_segment(self, tmp_path, monkeypatch):
        # Browsing the temp root with `temp` as a keyword hides everything in
        # it — proof the root segment is in the haystack, which is what keeps
        # this agreeing with the frontend's `${root}/${subfolder}`.
        self._sandbox(tmp_path, monkeypatch)
        (tmp_path / "a.png").write_bytes(b"x")
        resp = self._call({"type": "temp", "subfolder": "", "safe_kw": "temp", "safe_hide": "1"})
        assert self._names(resp) == set()

    def test_matches_a_requested_subfolder_segment(self, tmp_path, monkeypatch):
        self._sandbox(tmp_path, monkeypatch)
        sub = tmp_path / "nsfw"
        sub.mkdir()
        (sub / "a.png").write_bytes(b"x")
        resp = self._call(
            {"type": "output", "subfolder": "nsfw", "safe_kw": "nsfw", "safe_hide": "1"}
        )
        assert self._names(resp) == set()

    def test_matches_a_recursive_subpath_segment(self, tmp_path, monkeypatch):
        self._sandbox(tmp_path, monkeypatch)
        (tmp_path / "top.png").write_bytes(b"x")
        deep = tmp_path / "nsfw" / "2026"
        deep.mkdir(parents=True)
        (deep / "nested.png").write_bytes(b"x")
        resp = self._call(
            {
                "type": "output",
                "subfolder": "",
                "recursive": "1",
                "safe_kw": "nsfw",
                "safe_hide": "1",
            }
        )
        assert self._names(resp) == {"top.png"}

    def test_does_not_use_the_os_path_for_a_sandboxed_root(self, tmp_path, monkeypatch):
        # The resolved OS path contains the tmp_path segments; matching against
        # it would let a keyword drawn from the install location hide the whole
        # library, and the frontend — which never sees those segments — would
        # disagree about every file.
        root = tmp_path / "nsfw_install" / "output"
        root.mkdir(parents=True)
        (root / "holiday.png").write_bytes(b"x")
        self._sandbox(root, monkeypatch)
        resp = self._call({"type": "output", "subfolder": "", "safe_kw": "nsfw", "safe_hide": "1"})
        assert self._names(resp) == {"holiday.png"}


class TestListSafeHideControls(_Base):
    """Whole-token matching, at the endpoint. Substring matching fails these."""

    def test_short_keyword_does_not_hide_a_longer_named_folder(self, tmp_path, monkeypatch):
        self._sandbox(tmp_path, monkeypatch)
        (tmp_path / "assets").mkdir()
        resp = self._call({"type": "output", "subfolder": "", "safe_kw": "ass", "safe_hide": "1"})
        assert [d["name"] for d in resp._body["dirs"]] == ["assets"]

    def test_short_keyword_does_not_hide_files_under_a_longer_named_folder(
        self, tmp_path, monkeypatch
    ):
        self._sandbox(tmp_path, monkeypatch)
        sub = tmp_path / "assets"
        sub.mkdir()
        (sub / "a.png").write_bytes(b"x")
        resp = self._call(
            {"type": "output", "subfolder": "assets", "safe_kw": "ass", "safe_hide": "1"}
        )
        assert self._names(resp) == {"a.png"}

    def test_keyword_does_not_hide_a_file_whose_token_it_merely_prefixes(
        self, tmp_path, monkeypatch
    ):
        self._sandbox(tmp_path, monkeypatch)
        (tmp_path / "nsfwish.png").write_bytes(b"x")
        (tmp_path / "nsfw.png").write_bytes(b"x")
        resp = self._call({"type": "output", "subfolder": "", "safe_kw": "nsfw", "safe_hide": "1"})
        # The positive half is in the same assertion on purpose: a matcher that
        # hid nothing would otherwise satisfy the negative half alone.
        assert self._names(resp) == {"nsfwish.png"}


class TestListSafeHideOffByDefault(_Base):
    def test_no_params_filters_nothing(self, tmp_path, monkeypatch):
        self._sandbox(tmp_path, monkeypatch)
        (tmp_path / "my_nsfw_pic.png").write_bytes(b"x")
        resp = self._call({"type": "output", "subfolder": ""})
        assert self._names(resp) == {"my_nsfw_pic.png"}

    def test_keywords_without_the_hide_flag_filter_nothing(self, tmp_path, monkeypatch):
        # Blur-only is the default mode: the frontend wants the rows so it can
        # blur them, and only asks the server to drop them when the user turned
        # hiding on.
        self._sandbox(tmp_path, monkeypatch)
        (tmp_path / "my_nsfw_pic.png").write_bytes(b"x")
        resp = self._call({"type": "output", "subfolder": "", "safe_kw": "nsfw"})
        assert self._names(resp) == {"my_nsfw_pic.png"}

    def test_hide_flag_without_keywords_filters_nothing(self, tmp_path, monkeypatch):
        self._sandbox(tmp_path, monkeypatch)
        (tmp_path / "my_nsfw_pic.png").write_bytes(b"x")
        resp = self._call({"type": "output", "subfolder": "", "safe_kw": "", "safe_hide": "1"})
        assert self._names(resp) == {"my_nsfw_pic.png"}

    @pytest.mark.parametrize("flag", ["1", "true", "yes"])
    def test_accepted_truthy_values(self, flag, tmp_path, monkeypatch):
        self._sandbox(tmp_path, monkeypatch)
        (tmp_path / "my_nsfw_pic.png").write_bytes(b"x")
        resp = self._call(
            {"type": "output", "subfolder": "", "safe_kw": "nsfw", "safe_hide": flag}
        )
        assert self._names(resp) == set()

    def test_unrecognised_flag_filters_nothing_and_does_not_error(self, tmp_path, monkeypatch):
        # Same posture as `recursive`: an unrecognised value is inert, not a 400.
        self._sandbox(tmp_path, monkeypatch)
        (tmp_path / "my_nsfw_pic.png").write_bytes(b"x")
        resp = self._call(
            {"type": "output", "subfolder": "", "safe_kw": "nsfw", "safe_hide": "maybe"}
        )
        assert resp._body["ok"] is True
        assert self._names(resp) == {"my_nsfw_pic.png"}


class TestSafeHideAppliesAboveTheCap(_Base):
    """Hiding runs BEFORE the newest-N slice, so the cap ships a full page.

    Filtering after the slice would let a folder of mostly-sensitive files spend
    the whole budget on rows that are then dropped, leaving the user a near-empty
    grid they cannot tell from an empty folder. The sensitive files here are
    deliberately the NEWEST, so a below-the-cap filter returns nothing at all.
    """

    def _seed(self, tmp_path):
        # Clean files are older; sensitive files are newer and outnumber the cap.
        for i in range(5):
            p = tmp_path / f"holiday_{i}.png"
            p.write_bytes(b"x")
            os.utime(p, (1000 + i, 1000 + i))
        for i in range(10):
            p = tmp_path / f"nsfw_{i}.png"
            p.write_bytes(b"x")
            os.utime(p, (9000 + i, 9000 + i))

    def test_non_recursive_cap_is_spent_on_rows_that_ship(self, tmp_path, monkeypatch):
        self._sandbox(tmp_path, monkeypatch)
        self._seed(tmp_path)
        monkeypatch.setattr(gallery_loader, "DIR_LIST_CAP", 3)
        resp = self._call({"type": "output", "subfolder": "", "safe_kw": "nsfw", "safe_hide": "1"})
        names = self._names(resp)
        assert len(names) == 3, "the cap must be filled with non-matching files"
        assert all(n.startswith("holiday_") for n in names)

    def test_recursive_cap_is_spent_on_rows_that_ship(self, tmp_path, monkeypatch):
        self._sandbox(tmp_path, monkeypatch)
        self._seed(tmp_path)
        monkeypatch.setattr(gallery_loader, "FLAT_LIST_CAP", 3)
        resp = self._call(
            {
                "type": "output",
                "subfolder": "",
                "recursive": "1",
                "safe_kw": "nsfw",
                "safe_hide": "1",
            }
        )
        names = self._names(resp)
        assert len(names) == 3
        assert all(n.startswith("holiday_") for n in names)

    def test_truncated_describes_the_filtered_listing(self, tmp_path, monkeypatch):
        # 5 clean files survive a cap of 3, so the response IS truncated. Read
        # off the post-filter count — `truncated` must describe the listing the
        # caller received, not one it never saw.
        self._sandbox(tmp_path, monkeypatch)
        self._seed(tmp_path)
        monkeypatch.setattr(gallery_loader, "DIR_LIST_CAP", 3)
        resp = self._call({"type": "output", "subfolder": "", "safe_kw": "nsfw", "safe_hide": "1"})
        assert resp._body["truncated"] is True

    def test_not_truncated_when_the_survivors_fit(self, tmp_path, monkeypatch):
        self._sandbox(tmp_path, monkeypatch)
        self._seed(tmp_path)
        monkeypatch.setattr(gallery_loader, "DIR_LIST_CAP", 5)
        resp = self._call({"type": "output", "subfolder": "", "safe_kw": "nsfw", "safe_hide": "1"})
        assert len(self._names(resp)) == 5
        assert resp._body["truncated"] is False
