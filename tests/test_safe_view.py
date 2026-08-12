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


# ---------------------------------------------------------------------------
# The KEYWORD tier — dc:subject read off the file's XMP
# ---------------------------------------------------------------------------
#
# Name and path are whatever the user's folders happen to be called. This tier
# is the one the user can set, and the one that survives a move or a rename —
# a file tagged `nsfw` in digiKam is hidden here even when its name and folder
# say nothing.
#
# Each tag is TOKENIZED, exactly as the kit's `isSensitive` does it (`for (const
# tag of target.tags ?? []) for (const t of tokenize(tag))`). Comparing whole
# tags instead would make `nsfw art` stop matching `nsfw` in this pack while it
# kept matching in the browser, over the same bytes.


class TestIsSensitiveTags:
    def test_matches_a_tag(self):
        assert gallery_loader._is_sensitive("holiday.png", "output", ["nsfw"], ["nsfw"]) is True

    def test_tags_are_tokenized_like_every_other_haystack(self):
        # A multi-word keyword written in digiKam.
        assert gallery_loader._is_sensitive("a.png", "", ["nsfw"], ["nsfw art"]) is True

    def test_matches_case_insensitively(self):
        assert gallery_loader._is_sensitive("a.png", "", ["nsfw"], ["NSFW"]) is True

    def test_an_unrelated_tag_does_not_match(self):
        assert gallery_loader._is_sensitive("a.png", "", ["nsfw"], ["portrait"]) is False

    def test_short_keyword_does_not_match_a_longer_tag_token(self):
        # The control, on the tag tier: substring matching fails exactly here.
        assert gallery_loader._is_sensitive("a.png", "", ["ass"], ["assets"]) is False

    def test_keyword_does_not_match_a_tag_token_it_merely_prefixes(self):
        assert gallery_loader._is_sensitive("a.png", "", ["nsfw"], ["nsfwish"]) is False

    def test_no_tags_is_the_old_behaviour(self):
        assert gallery_loader._is_sensitive("nsfw.png", "", ["nsfw"], []) is True
        assert gallery_loader._is_sensitive("holiday.png", "", ["nsfw"], []) is False


class _TaggedBase(_Base):
    """Files whose NAME and FOLDER say nothing — only the XMP does."""

    def _tagged(self, tmp_path, name, tags, mtime=None):
        import xmp_meta

        p = tmp_path / name
        p.write_bytes(b"RIFF????WEBP")
        # A sidecar, so the fixture goes through the shipped packet builder
        # rather than a hand-rolled PNG container.
        (tmp_path / f"{name}.xmp").write_bytes(xmp_meta.build_xmp_packet(None, tags))
        if mtime is not None:
            os.utime(p, (mtime, mtime))
        return p

    def _plain(self, tmp_path, name, mtime=None):
        p = tmp_path / name
        p.write_bytes(b"RIFF????WEBP")
        if mtime is not None:
            os.utime(p, (mtime, mtime))
        return p


class TestListSurfacesTags(_TaggedBase):
    def test_every_row_carries_its_keywords(self, tmp_path, monkeypatch):
        self._sandbox(tmp_path, monkeypatch)
        self._tagged(tmp_path, "a.webp", ["portrait", "nsfw"])
        self._plain(tmp_path, "b.webp")
        rows = {f["name"]: f["tags"] for f in self._call({"type": "output"})._body["files"]}
        assert rows == {"a.webp": ["portrait", "nsfw"], "b.webp": []}


class TestListSafeHideByTag(_TaggedBase):
    def test_hides_a_file_matched_only_by_its_keywords(self, tmp_path, monkeypatch):
        # Innocuous name, innocuous folder — the tag is the only signal.
        self._sandbox(tmp_path, monkeypatch)
        self._tagged(tmp_path, "holiday.webp", ["nsfw"])
        self._plain(tmp_path, "beach.webp")
        resp = self._call({"type": "output", "safe_kw": "nsfw", "safe_hide": "1"})
        assert self._names(resp) == {"beach.webp"}

    def test_keywords_do_not_hide_without_the_flag(self, tmp_path, monkeypatch):
        self._sandbox(tmp_path, monkeypatch)
        self._tagged(tmp_path, "holiday.webp", ["nsfw"])
        resp = self._call({"type": "output", "safe_kw": "nsfw"})
        assert self._names(resp) == {"holiday.webp"}

    def test_an_unrelated_keyword_on_the_file_is_not_a_match(self, tmp_path, monkeypatch):
        self._sandbox(tmp_path, monkeypatch)
        self._tagged(tmp_path, "holiday.webp", ["portrait"])
        resp = self._call({"type": "output", "safe_kw": "nsfw", "safe_hide": "1"})
        assert self._names(resp) == {"holiday.webp"}

    def test_hides_in_the_recursive_listing_too(self, tmp_path, monkeypatch):
        self._sandbox(tmp_path, monkeypatch)
        deep = tmp_path / "2026"
        deep.mkdir()
        self._tagged(deep, "holiday.webp", ["nsfw"])
        self._plain(deep, "beach.webp")
        resp = self._call(
            {"type": "output", "recursive": "1", "safe_kw": "nsfw", "safe_hide": "1"}
        )
        assert self._names(resp) == {"beach.webp"}


class TestTagTierTopsThePageBackUp(_TaggedBase):
    """The keyword tier runs DURING the probe, so it cannot filter above the cap
    the way name/path can. The loop tops up instead: a row dropped for its tags
    is replaced by probing one more, so the cap still ships a full page.

    Without the top-up the newest N are probed once and the matches are simply
    subtracted — here that is a grid of ONE file where three were available.
    """

    def _seed(self, tmp_path):
        # The tagged files are the NEWEST, so a no-top-up loop spends the whole
        # cap on them.
        for i in range(4):
            self._tagged(tmp_path, f"tagged_{i}.webp", ["nsfw"], mtime=9000 + i)
        for i in range(3):
            self._plain(tmp_path, f"clean_{i}.webp", mtime=1000 + i)

    def test_the_cap_is_filled_with_rows_that_ship(self, tmp_path, monkeypatch):
        self._sandbox(tmp_path, monkeypatch)
        self._seed(tmp_path)
        monkeypatch.setattr(gallery_loader, "DIR_LIST_CAP", 3)
        resp = self._call({"type": "output", "safe_kw": "nsfw", "safe_hide": "1"})
        names = self._names(resp)
        assert len(names) == 3, "the tag tier must top the page back up to the cap"
        assert all(n.startswith("clean_") for n in names)

    def test_not_truncated_when_every_survivor_shipped(self, tmp_path, monkeypatch):
        # All 3 clean files fit, and nothing was left unexamined.
        self._sandbox(tmp_path, monkeypatch)
        self._seed(tmp_path)
        monkeypatch.setattr(gallery_loader, "DIR_LIST_CAP", 5)
        resp = self._call({"type": "output", "safe_kw": "nsfw", "safe_hide": "1"})
        assert len(self._names(resp)) == 3
        assert resp._body["truncated"] is False

    def test_the_probe_budget_bounds_the_pathological_case(self, tmp_path, monkeypatch):
        # Everything is tagged: rather than probe the whole tree, the loop stops
        # at cap * PROBE_BUDGET_FACTOR and says the listing is truncated.
        self._sandbox(tmp_path, monkeypatch)
        for i in range(9):
            self._tagged(tmp_path, f"tagged_{i}.webp", ["nsfw"], mtime=9000 + i)
        monkeypatch.setattr(gallery_loader, "DIR_LIST_CAP", 2)
        monkeypatch.setattr(gallery_loader, "PROBE_BUDGET_FACTOR", 2)
        resp = self._call({"type": "output", "safe_kw": "nsfw", "safe_hide": "1"})
        assert self._names(resp) == set()
        assert resp._body["truncated"] is True

    def test_probe_count_is_unchanged_when_hiding_is_off(self, tmp_path, monkeypatch):
        # The top-up must not cost anything on the ordinary path: with no
        # keywords the loop probes exactly `cap` rows, as it always did.
        self._sandbox(tmp_path, monkeypatch)
        self._seed(tmp_path)
        monkeypatch.setattr(gallery_loader, "DIR_LIST_CAP", 3)
        probed = []
        real = gallery_loader._scan_file_entry
        monkeypatch.setattr(
            gallery_loader,
            "_scan_file_entry",
            lambda *a, **k: (probed.append(a[1]), real(*a, **k))[1],
        )
        self._call({"type": "output"})
        assert len(probed) == 3


# ---------------------------------------------------------------------------
# /gallery_loader/tag
# ---------------------------------------------------------------------------


class _FakePostRequest:
    def __init__(self, body):
        self._body = body

    async def json(self):
        return self._body


class TestTagEndpoint(_TaggedBase):
    def _post(self, body):
        return asyncio.run(gallery_loader.gallery_set_tag(_FakePostRequest(body)))

    def test_marks_a_file_and_answers_with_what_was_stored(self, tmp_path, monkeypatch):
        self._sandbox(tmp_path, monkeypatch)
        self._tagged(tmp_path, "a.webp", ["portrait"])
        resp = self._post(
            {"type": "output", "subfolder": "", "name": "a.webp", "tag": "nsfw", "present": True}
        )
        assert resp._body["ok"] is True
        # The file's OTHER keyword survives — the same law as the rating write.
        assert resp._body["tags"] == ["portrait", "nsfw"]
        import xmp_meta

        assert xmp_meta.read_tags(str(tmp_path / "a.webp")) == ["portrait", "nsfw"]

    def test_unmarks_a_file(self, tmp_path, monkeypatch):
        self._sandbox(tmp_path, monkeypatch)
        self._tagged(tmp_path, "a.webp", ["portrait", "nsfw"])
        resp = self._post(
            {"type": "output", "subfolder": "", "name": "a.webp", "tag": "nsfw", "present": False}
        )
        assert resp._body["tags"] == ["portrait"]

    def test_the_answer_is_read_back_not_echoed(self, tmp_path, monkeypatch):
        # The file already carries the keyword under a different casing, so the
        # stored value is NOT the one that was sent.
        self._sandbox(tmp_path, monkeypatch)
        self._tagged(tmp_path, "a.webp", ["NSFW"])
        resp = self._post(
            {"type": "output", "subfolder": "", "name": "a.webp", "tag": "nsfw", "present": True}
        )
        assert resp._body["tags"] == ["NSFW"]

    def test_rejects_a_missing_file(self, tmp_path, monkeypatch):
        self._sandbox(tmp_path, monkeypatch)
        resp = self._post(
            {"type": "output", "subfolder": "", "name": "gone.webp", "tag": "n", "present": True}
        )
        assert resp.status == 404

    @pytest.mark.parametrize(
        ("body", "expected"),
        [
            ({"name": "a.webp", "tag": "nsfw"}, "present must be a boolean"),
            ({"name": "a.webp", "tag": "nsfw", "present": "yes"}, "present must be a boolean"),
            ({"name": "a.webp", "tag": "", "present": True}, "invalid tag"),
            ({"name": "a.webp", "tag": "   ", "present": True}, "invalid tag"),
            ({"name": "a.webp", "tag": None, "present": True}, "invalid tag"),
            ({"name": "a.webp", "tag": "a\x00b", "present": True}, "invalid tag"),
            ({"name": "../a.webp", "tag": "nsfw", "present": True}, "invalid name"),
            ({"name": "sub/a.webp", "tag": "nsfw", "present": True}, "invalid name"),
            ({"name": "a.txt", "tag": "nsfw", "present": True}, "unsupported file type"),
        ],
    )
    def test_validation(self, body, expected):
        parsed, err = gallery_loader._validate_tag_request(body)
        assert parsed is None
        assert expected in err

    def test_a_well_formed_request_validates(self):
        parsed, err = gallery_loader._validate_tag_request(
            {"type": "output", "subfolder": "s", "name": "a.png", "tag": " nsfw ", "present": True}
        )
        assert err == ""
        # Normalised by the same function the writer uses, so a value that
        # would not survive the round trip is rejected rather than written.
        assert parsed["tag"] == "nsfw"
        assert parsed["present"] is True
