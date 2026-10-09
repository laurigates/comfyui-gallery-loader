"""Safe View's opt-in prompt-metadata tier — the fourth haystack.

A PORT of comfyui-image-browser's tier (that pack's PR #83), not a re-derivation:
the two gallery packs render the same files off the same disk, read the same
``<user_dir>/comfy-safeview.sqlite`` cache through the same vendored
``safeview_store.py``, and must therefore agree file-for-file about which of
them a prompt makes sensitive. The assertions below are image-browser's
``TestSafeViewStore`` / ``TestListSafePromptTier`` / ``TestSafeViewSweepTrigger``
/ ``TestSafeViewWarmEndpoint``, adapted to this pack's handlers.

Fixtures are REAL containers with REAL embedded metadata, synthesized in
process (conftest stubs PIL, so nothing here may depend on an encoder). The
suite opens with a CONTROL asserting the parser actually reads one: a fixture
the parser could not read would make every "does not match" assertion below
pass while testing nothing.

EVERY ASSERTION IS TWO-SIDED, because this tier's fail-safe direction is
BLURRED. "An unscanned file reads unscanned" passes against a verdict path that
answers "unscanned" for everything; "a folder card carries no verdict" passes
against a tier that never runs. Each such assertion carries the opposite
direction in the same test.

DISCRETION, NOT ACCESS CONTROL — like the rest of Safe View, these pin
behaviour, not a security boundary.
"""

from __future__ import annotations

import asyncio
import json
import os
import zlib
from types import SimpleNamespace

import pytest

import gallery_loader
import image_meta
import safeview_store

# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


def _png_chunk(ctype: bytes, data: bytes) -> bytes:
    body = ctype + data
    return len(data).to_bytes(4, "big") + body + (zlib.crc32(body) & 0xFFFFFFFF).to_bytes(4, "big")


def _png_with_prompt(positive: str, model: str = "sd_xl_base_1.0.safetensors") -> bytes:
    """A PNG carrying one `prompt` tEXt chunk holding a ComfyUI API graph."""
    graph = {
        "4": {"class_type": "CheckpointLoaderSimple", "inputs": {"ckpt_name": model}},
        "6": {"class_type": "CLIPTextEncode", "inputs": {"text": positive, "clip": ["4", 1]}},
        "7": {"class_type": "CLIPTextEncode", "inputs": {"text": "blurry", "clip": ["4", 1]}},
        "3": {
            "class_type": "KSampler",
            "inputs": {
                "seed": 1,
                "steps": 20,
                "cfg": 8.0,
                "sampler_name": "euler",
                "scheduler": "normal",
                "model": ["4", 0],
                "positive": ["6", 0],
                "negative": ["7", 0],
            },
        },
    }
    payload = b"prompt\x00" + json.dumps(graph).encode()
    return image_meta.PNG_SIG + b"".join(
        [
            _png_chunk(b"IHDR", b"\x00" * 13),
            _png_chunk(b"tEXt", payload),
            _png_chunk(b"IEND", b""),
        ]
    )


class _FakeGetRequest:
    def __init__(self, query):
        self.rel_url = SimpleNamespace(query=query)


class _FakePostRequest:
    """A well-formed JSON POST — the Content-Type guard has to be satisfied."""

    def __init__(self, body):
        self._body = body
        self.headers = {"Content-Type": "application/json"}

    async def json(self):
        return self._body


def _sandbox(base, monkeypatch):
    import folder_paths

    monkeypatch.setattr(folder_paths, "get_directory_by_type", lambda t: str(base), raising=False)
    monkeypatch.setattr(
        folder_paths, "get_user_directory", lambda: str(base / "_user"), raising=False
    )
    (base / "_user").mkdir(exist_ok=True)


def _list(query):
    return asyncio.run(gallery_loader.gallery_list(_FakeGetRequest(query)))


def _by_name(resp):
    return {f["name"]: f for f in resp._body["files"]}


def _warm(base, *names):
    db = safeview_store.db_path(str(base / "_user"))
    return safeview_store.scan_paths(db, [str(base / n) for n in names])


# ---------------------------------------------------------------------------
# The vendored store
# ---------------------------------------------------------------------------


class TestSafeViewStore:
    """The sqlite text cache in safeview_store.py (vendored from image-browser)."""

    def test_CONTROL_the_fixture_really_carries_a_readable_prompt(self, tmp_path):
        """Every assertion in this file rests on this, and the dependency is
        invisible from the assertions themselves: if the builder produced a PNG
        image_meta could not read, extract_text would return "" and every
        "does not match" test below would pass having proved nothing."""
        f = tmp_path / "a.png"
        f.write_bytes(_png_with_prompt("a cat in a hat"))
        text = safeview_store.extract_text(str(f))
        assert "cat" in text
        assert "sd_xl_base_1.0.safetensors" in text

    def test_key_shape_matches_thumb_cache(self, tmp_path):
        """Same key as the thumbnail cache — path + mtime_ns + size. One
        invalidation model to reason about, not two."""
        import thumb_cache

        f = tmp_path / "a.png"
        f.write_bytes(b"x")
        st = os.stat(f)
        assert safeview_store.cache_key(str(f), st) == thumb_cache.cache_key(str(f), st)

    def test_an_edited_file_keys_a_fresh_entry(self, tmp_path):
        f = tmp_path / "a.png"
        f.write_bytes(b"x")
        first = safeview_store.cache_key(str(f), os.stat(f))
        f.write_bytes(b"xy")
        assert safeview_store.cache_key(str(f), os.stat(f)) != first

    def test_round_trip_and_a_missing_key_is_ABSENT(self, tmp_path):
        """Absent, never empty-string. "not scanned yet" and "scanned, carries
        no prompt" are different facts, and the endpoint turns exactly that
        difference into `"unscanned"` versus `false`."""
        db = str(tmp_path / "c.sqlite")
        assert safeview_store.store_texts(db, [("k1", "a cat")]) == 1
        assert safeview_store.read_cached(db, ["k1", "k2"]) == {"k1": "a cat"}

    def test_a_file_with_no_metadata_is_still_CACHED_as_empty(self, tmp_path):
        """Otherwise every screenshot in the library is re-parsed forever and
        stays "unscanned" — and therefore blurred — however often the sweep
        runs."""
        db = str(tmp_path / "c.sqlite")
        f = tmp_path / "plain.png"
        f.write_bytes(image_meta.PNG_SIG + _png_chunk(b"IEND", b""))
        safeview_store.scan_paths(db, [str(f)])
        key = safeview_store.cache_key(str(f), os.stat(f))
        assert safeview_store.read_cached(db, [key]) == {key: ""}

    def test_a_READ_creates_nothing_on_disk(self, tmp_path):
        """A read must have no side effects — a listing against a mis-resolved
        user directory must not mkdir it. Two-sided: the WRITE must still create
        what it needs, or "nothing was created" passes against a store that
        never works at all."""
        nested = tmp_path / "does" / "not" / "exist"
        db = str(nested / "c.sqlite")
        assert safeview_store.read_cached(db, ["k"]) == {}
        assert not nested.exists()
        assert safeview_store.store_texts(db, [("k", "v")]) == 1
        assert nested.is_dir()

    def test_scan_paths_skips_a_file_that_vanished(self, tmp_path):
        """A sweep racing a delete is normal, not an error. Both in one batch:
        `0` on its own passes against a scanner that never scans anything."""
        db = str(tmp_path / "c.sqlite")
        present = tmp_path / "here.png"
        present.write_bytes(_png_with_prompt("a cat in a hat"))
        assert safeview_store.scan_paths(db, [str(tmp_path / "gone.png"), str(present)]) == 1

    def test_an_already_cached_file_is_not_re_parsed(self, tmp_path):
        db = str(tmp_path / "c.sqlite")
        f = tmp_path / "a.png"
        f.write_bytes(_png_with_prompt("a cat in a hat"))
        assert safeview_store.scan_paths(db, [str(f)]) == 1
        assert safeview_store.scan_paths(db, [str(f)]) == 0

    def test_the_text_is_capped(self, tmp_path):
        f = tmp_path / "a.png"
        f.write_bytes(_png_with_prompt("cat " * 4000))
        assert len(safeview_store.extract_text(str(f))) <= safeview_store.MAX_TEXT_BYTES

    def test_an_unwritable_cache_degrades_instead_of_raising(self, tmp_path):
        """A cache is an optimisation. A listing must still answer when the user
        dir is read-only or the disk is full. Paired positive: a store that
        never worked would satisfy the first two assertions on its own."""
        blocker = tmp_path / "not-a-dir"
        blocker.write_bytes(b"x")
        db = str(blocker / "c.sqlite")
        assert safeview_store.store_texts(db, [("k", "v")]) == 0
        assert safeview_store.read_cached(db, ["k"]) == {}
        good = str(tmp_path / "good.sqlite")
        assert safeview_store.store_texts(good, [("k", "v")]) == 1
        assert safeview_store.read_cached(good, ["k"]) == {"k": "v"}

    def test_walk_candidates_filters_by_extension_and_skips_hidden(self, tmp_path):
        (tmp_path / "keep.png").write_bytes(b"x")
        (tmp_path / "skip.avi").write_bytes(b"x")
        (tmp_path / ".hidden.png").write_bytes(b"x")
        sub = tmp_path / "clipspace"
        sub.mkdir()
        (sub / "deep.png").write_bytes(b"x")
        found = safeview_store.walk_candidates([str(tmp_path)], {".png"})
        assert [os.path.basename(p) for p in found] == ["keep.png"]

    def test_walk_candidates_does_not_follow_a_symlinked_dir(self, tmp_path):
        outside = tmp_path / "outside"
        outside.mkdir()
        (outside / "secret.png").write_bytes(b"x")
        inner = tmp_path / "inner"
        inner.mkdir()
        (inner / "real.png").write_bytes(b"x")
        (inner / "link").symlink_to(outside, target_is_directory=True)
        # `real.png` must be found, so an empty result cannot pass here.
        found = safeview_store.walk_candidates([str(inner)], {".png"})
        assert [os.path.basename(p) for p in found] == ["real.png"]


# ---------------------------------------------------------------------------
# /gallery_loader/list?safe_prompt=1
# ---------------------------------------------------------------------------


class TestMetadataExts:
    def test_participation_is_images_plus_the_video_containers_image_meta_reads(self):
        """The same set comfyui-image-browser derives, from the same two inputs.
        A file that participates in one pack and not the other is blurred in
        one grid and plain in the other over the same bytes."""
        expected = gallery_loader.IMG_EXTS | (
            gallery_loader.VIDEO_EXTS & set(image_meta.FORMAT_EXTS)
        )
        assert expected == gallery_loader.METADATA_EXTS
        assert ".mp4" in gallery_loader.METADATA_EXTS
        assert ".avi" not in gallery_loader.METADATA_EXTS
        assert ".flac" not in gallery_loader.METADATA_EXTS


class TestListSafePromptTier:
    """`safe_prompt` on /list — the four verdict states and the request gate."""

    @pytest.fixture(autouse=True)
    def _no_sweep(self, monkeypatch):
        # The lazy sweep is asserted on its own below. Stubbed here so the
        # endpoint tests neither leave a pending asyncio task behind every
        # asyncio.run() nor walk a tree in the background.
        monkeypatch.setattr(gallery_loader, "_maybe_start_sweep", lambda: None)

    def _mixed(self, base):
        (base / "cat.png").write_bytes(_png_with_prompt("a cat in a hat"))
        (base / "leather.png").write_bytes(_png_with_prompt("a nsfw leather couch"))

    def test_a_cold_cache_answers_UNSCANNED_and_counts_it(self, tmp_path, monkeypatch):
        """The fail-safe state, BOTH DIRECTIONS in the same listing: one file is
        warmed first and must come back with a real verdict; the other must
        not. The one-sided version passes against a verdict path that answers
        `"unscanned"` for everything."""
        _sandbox(tmp_path, monkeypatch)
        self._mixed(tmp_path)
        assert _warm(tmp_path, "cat.png") == 1
        resp = _list({"type": "output", "safe_kw": "nsfw", "safe_prompt": "1"})
        files = _by_name(resp)
        assert files["cat.png"]["prompt_match"] is False
        assert files["leather.png"]["prompt_match"] == "unscanned"
        assert resp._body["safe_unscanned"] == 1

    def test_a_warm_cache_answers_the_verdict(self, tmp_path, monkeypatch):
        _sandbox(tmp_path, monkeypatch)
        self._mixed(tmp_path)
        assert _warm(tmp_path, "cat.png", "leather.png") == 2
        resp = _list({"type": "output", "safe_kw": "nsfw", "safe_prompt": "1"})
        files = _by_name(resp)
        assert files["leather.png"]["prompt_match"] is True
        assert files["cat.png"]["prompt_match"] is False
        assert resp._body["safe_unscanned"] == 0

    def test_the_model_name_is_part_of_the_haystack(self, tmp_path, monkeypatch):
        _sandbox(tmp_path, monkeypatch)
        (tmp_path / "a.png").write_bytes(_png_with_prompt("a cat", model="ponyxl.safetensors"))
        (tmp_path / "b.png").write_bytes(_png_with_prompt("a cat", model="sdxl.safetensors"))
        _warm(tmp_path, "a.png", "b.png")
        files = _by_name(_list({"type": "output", "safe_kw": "ponyxl", "safe_prompt": "1"}))
        assert files["a.png"]["prompt_match"] is True
        assert files["b.png"]["prompt_match"] is False

    def test_CONTROL_the_prompt_is_matched_as_WHOLE_TOKENS(self, tmp_path, monkeypatch):
        """`ass` must not match "a bag of assets". A substring implementation
        passes every positive test above and fails only this. Same matcher as
        the name/path/tag tiers (`_is_sensitive` / `_safe_tokens`)."""
        _sandbox(tmp_path, monkeypatch)
        (tmp_path / "bag.png").write_bytes(_png_with_prompt("a bag of assets"))
        (tmp_path / "hit.png").write_bytes(_png_with_prompt("one ass and a hat"))
        _warm(tmp_path, "bag.png", "hit.png")
        files = _by_name(_list({"type": "output", "safe_kw": "ass", "safe_prompt": "1"}))
        assert files["bag.png"]["prompt_match"] is False
        assert files["hit.png"]["prompt_match"] is True

    def test_CONTROL_a_container_with_no_reader_carries_NO_verdict_key(
        self, tmp_path, monkeypatch
    ):
        """The fourth state, and the one easiest to collapse. An `.avi` is
        listed but has no metadata reader, so it does not participate — the key
        must be ABSENT, not `"unscanned"`, or every unreadable file blurs the
        moment the tier comes on. Paired positive: the readable file in the
        SAME listing must still carry one."""
        _sandbox(tmp_path, monkeypatch)
        (tmp_path / "clip.avi").write_bytes(b"x")
        (tmp_path / "cat.png").write_bytes(_png_with_prompt("a cat in a hat"))
        resp = _list(
            {
                "type": "output",
                "safe_kw": "nsfw",
                "safe_prompt": "1",
                "extensions": ".png,.avi",
            }
        )
        files = _by_name(resp)
        assert "prompt_match" not in files["clip.avi"]
        assert files["cat.png"]["prompt_match"] == "unscanned"
        # And the unreadable one is not counted as work the sweep will ever do.
        assert resp._body["safe_unscanned"] == 1

    def test_CONTROL_folder_cards_never_carry_a_verdict(self, tmp_path, monkeypatch):
        _sandbox(tmp_path, monkeypatch)
        (tmp_path / "holiday").mkdir()
        (tmp_path / "cat.png").write_bytes(_png_with_prompt("a cat in a hat"))
        resp = _list({"type": "output", "safe_kw": "nsfw", "safe_prompt": "1"})
        dirs = {d["name"]: d for d in resp._body["dirs"]}
        assert "holiday" in dirs
        assert all("prompt_match" not in d for d in dirs.values())
        assert _by_name(resp)["cat.png"]["prompt_match"] == "unscanned"

    def test_the_default_listing_is_unchanged(self, tmp_path, monkeypatch):
        """No flag, no verdict keys, no count. Paired positive on the same tree:
        absence alone passes against a tier that never runs at all."""
        _sandbox(tmp_path, monkeypatch)
        self._mixed(tmp_path)
        resp = _list({"type": "output"})
        assert "safe_unscanned" not in resp._body
        assert all("prompt_match" not in f for f in resp._body["files"])
        on = _list({"type": "output", "safe_kw": "nsfw", "safe_prompt": "1"})
        assert on._body["safe_unscanned"] == 2

    def test_the_flag_without_keywords_does_nothing(self, tmp_path, monkeypatch):
        """Same rule as `safe_hide`: a request that forgot the list must not blur
        a user's whole grid on verdicts nobody asked for."""
        _sandbox(tmp_path, monkeypatch)
        self._mixed(tmp_path)
        resp = _list({"type": "output", "safe_kw": "", "safe_prompt": "1"})
        assert "safe_unscanned" not in resp._body
        assert all("prompt_match" not in f for f in resp._body["files"])
        on = _list({"type": "output", "safe_kw": "nsfw", "safe_prompt": "1"})
        assert on._body["safe_unscanned"] == 2

    def test_an_unrecognised_flag_value_does_nothing(self, tmp_path, monkeypatch):
        _sandbox(tmp_path, monkeypatch)
        self._mixed(tmp_path)
        resp = _list({"type": "output", "safe_kw": "nsfw", "safe_prompt": "maybe"})
        assert all("prompt_match" not in f for f in resp._body["files"])
        on = _list({"type": "output", "safe_kw": "nsfw", "safe_prompt": "1"})
        assert all("prompt_match" in f for f in on._body["files"])

    def test_the_prompt_is_consulted_ONLY_through_this_flag(self, tmp_path, monkeypatch):
        """Hiding on its own keeps matching names and paths; a matching PROMPT
        is simply not consulted. The third file matches on its NAME, so the one
        assertion carries both directions."""
        _sandbox(tmp_path, monkeypatch)
        self._mixed(tmp_path)
        (tmp_path / "my_nsfw_pic.png").write_bytes(_png_with_prompt("a cat in a hat"))
        _warm(tmp_path, "cat.png", "leather.png", "my_nsfw_pic.png")
        resp = _list({"type": "output", "safe_kw": "nsfw", "safe_hide": "1"})
        assert set(_by_name(resp)) == {"cat.png", "leather.png"}

    def test_hiding_DROPS_a_prompt_match(self, tmp_path, monkeypatch):
        _sandbox(tmp_path, monkeypatch)
        self._mixed(tmp_path)
        _warm(tmp_path, "cat.png", "leather.png")
        resp = _list({"type": "output", "safe_kw": "nsfw", "safe_hide": "1", "safe_prompt": "1"})
        assert set(_by_name(resp)) == {"cat.png"}

    def test_hiding_also_drops_an_UNSCANNED_file_and_reports_it(self, tmp_path, monkeypatch):
        """Mirrors the kit's isSensitive, which reads `"unscanned"` as sensitive
        — hiding mode has no blur to fall back on. `cat.png` is warmed and
        clean, so it MUST survive: an empty survivor set alone passes against an
        endpoint that drops everything."""
        _sandbox(tmp_path, monkeypatch)
        self._mixed(tmp_path)
        assert _warm(tmp_path, "cat.png") == 1
        resp = _list({"type": "output", "safe_kw": "nsfw", "safe_hide": "1", "safe_prompt": "1"})
        assert set(_by_name(resp)) == {"cat.png"}
        assert resp._body["safe_unscanned"] == 1

    def test_the_tier_reaches_the_recursive_walk(self, tmp_path, monkeypatch):
        """Flat view is a separate call site; a tier wired only into the
        non-recursive lister would silently stop applying there."""
        _sandbox(tmp_path, monkeypatch)
        deep = tmp_path / "sub"
        deep.mkdir()
        (deep / "leather.png").write_bytes(_png_with_prompt("a nsfw leather couch"))
        (deep / "cat.png").write_bytes(_png_with_prompt("a cat in a hat"))
        _warm(tmp_path, "sub/leather.png", "sub/cat.png")
        files = _by_name(
            _list({"type": "output", "recursive": "1", "safe_kw": "nsfw", "safe_prompt": "1"})
        )
        assert files["leather.png"]["prompt_match"] is True
        assert files["cat.png"]["prompt_match"] is False

    def test_the_tier_applies_on_the_path_tab_too(self, tmp_path, monkeypatch):
        """The VHS path browser opens folders outside the sandboxed roots — the
        place an unexpected folder is most likely to be opened."""
        _sandbox(tmp_path, monkeypatch)
        self._mixed(tmp_path)
        _warm(tmp_path, "leather.png", "cat.png")
        files = _by_name(
            _list({"type": "path", "path": str(tmp_path), "safe_kw": "nsfw", "safe_prompt": "1"})
        )
        assert files["leather.png"]["prompt_match"] is True
        assert files["cat.png"]["prompt_match"] is False


class TestPromptTierAppliesAboveTheCap:
    """With hiding on, verdicts decide MEMBERSHIP, so they are computed for every
    candidate before the newest-N slice — the same rule `_probe_newest` already
    follows for the name/path tier. Filtering below the cap would answer a
    folder of newest-but-sensitive renders with a near-empty page."""

    def test_hidden_prompt_matches_do_not_spend_the_cap(self, tmp_path, monkeypatch):
        _sandbox(tmp_path, monkeypatch)
        monkeypatch.setattr(gallery_loader, "_maybe_start_sweep", lambda: None)
        monkeypatch.setattr(gallery_loader, "DIR_LIST_CAP", 3)
        # Three NEWEST files match by prompt; three older ones are clean.
        names = []
        for i in range(6):
            name = f"f{i}.png"
            positive = "a nsfw scene" if i >= 3 else "a cat"
            (tmp_path / name).write_bytes(_png_with_prompt(positive))
            os.utime(tmp_path / name, (1000 + i, 1000 + i))
            names.append(name)
        _warm(tmp_path, *names)
        resp = _list({"type": "output", "safe_kw": "nsfw", "safe_hide": "1", "safe_prompt": "1"})
        assert set(_by_name(resp)) == {"f0.png", "f1.png", "f2.png"}

    def test_without_hiding_only_the_shipped_rows_are_judged(self, tmp_path, monkeypatch):
        """Blur-only needs a verdict only for what ships, so the count describes
        the page, not the whole tree. Two-sided: the shipped rows DO carry it."""
        _sandbox(tmp_path, monkeypatch)
        monkeypatch.setattr(gallery_loader, "_maybe_start_sweep", lambda: None)
        monkeypatch.setattr(gallery_loader, "DIR_LIST_CAP", 2)
        for i in range(5):
            (tmp_path / f"f{i}.png").write_bytes(_png_with_prompt("a cat"))
            os.utime(tmp_path / f"f{i}.png", (1000 + i, 1000 + i))
        resp = _list({"type": "output", "safe_kw": "nsfw", "safe_prompt": "1"})
        assert len(resp._body["files"]) == 2
        assert all(f["prompt_match"] == "unscanned" for f in resp._body["files"])
        assert resp._body["safe_unscanned"] == 2


class TestSafeViewSweepTrigger:
    """When the lazy background sweep is started."""

    def _arm(self, base, monkeypatch, calls):
        _sandbox(base, monkeypatch)
        monkeypatch.setattr(gallery_loader, "_maybe_start_sweep", lambda: calls.append(1))

    def test_a_listing_with_unscanned_files_starts_the_sweep(self, tmp_path, monkeypatch):
        calls = []
        self._arm(tmp_path, monkeypatch, calls)
        (tmp_path / "cat.png").write_bytes(_png_with_prompt("a cat in a hat"))
        _list({"type": "output", "safe_kw": "nsfw", "safe_prompt": "1"})
        assert calls == [1]

    def test_a_fully_cached_listing_does_NOT_start_one(self, tmp_path, monkeypatch):
        """A warm library must not re-walk the output tree on every request.
        Paired positive: adding one uncached file must start it."""
        calls = []
        self._arm(tmp_path, monkeypatch, calls)
        (tmp_path / "cat.png").write_bytes(_png_with_prompt("a cat in a hat"))
        _warm(tmp_path, "cat.png")
        _list({"type": "output", "safe_kw": "nsfw", "safe_prompt": "1"})
        assert calls == []
        (tmp_path / "new.png").write_bytes(_png_with_prompt("a dog in a hat"))
        _list({"type": "output", "safe_kw": "nsfw", "safe_prompt": "1"})
        assert calls == [1]

    def test_a_listing_without_the_flag_never_starts_one(self, tmp_path, monkeypatch):
        """A user who never enables the tier never pays for a walk of their
        output tree. Paired positive on the SAME uncached tree."""
        calls = []
        self._arm(tmp_path, monkeypatch, calls)
        (tmp_path / "cat.png").write_bytes(_png_with_prompt("a cat in a hat"))
        _list({"type": "output"})
        assert calls == []
        _list({"type": "output", "safe_kw": "nsfw", "safe_prompt": "1"})
        assert calls == [1]

    def test_the_sweep_fails_soft_without_a_running_loop(self, tmp_path, monkeypatch):
        """Called from a context with no event loop (a unit test, an import-time
        caller), it must neither raise nor record a sweep as started."""
        _sandbox(tmp_path, monkeypatch)
        monkeypatch.setattr(gallery_loader, "_sweep_task", None)
        gallery_loader._maybe_start_sweep()
        assert gallery_loader._sweep_task is None

    def test_the_sweep_actually_caches_the_backlog(self, tmp_path, monkeypatch):
        """End to end, through the real trigger: a cold listing starts a sweep
        that leaves the file cached, so the NEXT listing has a verdict."""
        _sandbox(tmp_path, monkeypatch)
        monkeypatch.setattr(gallery_loader, "_sweep_task", None)
        monkeypatch.setattr(gallery_loader, "_sweep_started_at", 0.0)
        (tmp_path / "leather.png").write_bytes(_png_with_prompt("a nsfw leather couch"))

        async def run():
            q = {"type": "output", "safe_kw": "nsfw", "safe_prompt": "1"}
            first = await gallery_loader.gallery_list(_FakeGetRequest(q))
            assert gallery_loader._sweep_task is not None
            await gallery_loader._sweep_task
            second = await gallery_loader.gallery_list(_FakeGetRequest(q))
            return first, second

        first, second = asyncio.run(run())
        assert _by_name(first)["leather.png"]["prompt_match"] == "unscanned"
        assert _by_name(second)["leather.png"]["prompt_match"] is True


# ---------------------------------------------------------------------------
# POST /gallery_loader/safeview_warm
# ---------------------------------------------------------------------------


class TestSafeViewWarmEndpoint:
    """The `executed` fast warmer's landing point."""

    def _post(self, body):
        return asyncio.run(gallery_loader.gallery_safeview_warm(_FakePostRequest(body)))

    def _cached(self, base, *names):
        db = safeview_store.db_path(str(base / "_user"))
        keys = {n: safeview_store.cache_key(str(base / n), os.stat(base / n)) for n in names}
        got = safeview_store.read_cached(db, list(keys.values()))
        return {n for n, k in keys.items() if k in got}

    def test_scans_and_caches_a_freshly_rendered_file(self, tmp_path, monkeypatch):
        _sandbox(tmp_path, monkeypatch)
        (tmp_path / "leather.png").write_bytes(_png_with_prompt("a nsfw leather couch"))
        resp = self._post({"items": [{"type": "output", "subfolder": "", "name": "leather.png"}]})
        assert resp._body == {"ok": True, "scanned": 1}
        assert self._cached(tmp_path, "leather.png") == {"leather.png"}

    def test_rejects_type_path(self, tmp_path, monkeypatch):
        """Same perimeter as every write. A valid sandboxed sibling in the SAME
        batch: `scanned: 0` alone passes against an endpoint that scans
        nothing at all."""
        _sandbox(tmp_path, monkeypatch)
        (tmp_path / "leather.png").write_bytes(_png_with_prompt("a nsfw leather couch"))
        (tmp_path / "cat.png").write_bytes(_png_with_prompt("a cat in a hat"))
        resp = self._post(
            {
                "items": [
                    {"type": "path", "subfolder": str(tmp_path), "name": "leather.png"},
                    {"type": "output", "subfolder": "", "name": "cat.png"},
                ]
            }
        )
        assert resp._body == {"ok": True, "scanned": 1}
        assert self._cached(tmp_path, "leather.png", "cat.png") == {"cat.png"}

    def test_SKIPS_an_unreadable_container_rather_than_failing_the_batch(
        self, tmp_path, monkeypatch
    ):
        """The frontend posts every output of one execution. A mixed batch must
        not lose its images because one entry was an .avi."""
        _sandbox(tmp_path, monkeypatch)
        (tmp_path / "clip.avi").write_bytes(b"x")
        (tmp_path / "cat.png").write_bytes(_png_with_prompt("a cat in a hat"))
        resp = self._post(
            {
                "items": [
                    {"type": "output", "subfolder": "", "name": "clip.avi"},
                    {"type": "output", "subfolder": "", "name": "cat.png"},
                ]
            }
        )
        assert resp._body == {"ok": True, "scanned": 1}

    def test_skips_a_malformed_item_rather_than_raising(self, tmp_path, monkeypatch):
        _sandbox(tmp_path, monkeypatch)
        (tmp_path / "cat.png").write_bytes(_png_with_prompt("a cat in a hat"))
        resp = self._post(
            {
                "items": [
                    "not-an-object",
                    {"type": "output", "subfolder": 7, "name": "cat.png"},
                    {"type": "output", "subfolder": "", "name": "../cat.png"},
                    {"type": "output", "subfolder": "", "name": "cat.png"},
                ]
            }
        )
        assert resp._body == {"ok": True, "scanned": 1}

    def test_caps_the_batch(self, tmp_path, monkeypatch):
        _sandbox(tmp_path, monkeypatch)
        items = [
            {"type": "output", "subfolder": "", "name": f"a{i}.png"}
            for i in range(gallery_loader.MAX_WARM_BATCH + 1)
        ]
        resp = self._post({"items": items})
        assert resp.status == 400
        assert "max" in resp._body["error"]
        # Paired: a batch AT the cap is accepted.
        ok = self._post({"items": items[: gallery_loader.MAX_WARM_BATCH]})
        assert ok._body == {"ok": True, "scanned": 0}

    def test_rejects_an_empty_or_missing_list(self, tmp_path, monkeypatch):
        _sandbox(tmp_path, monkeypatch)
        assert self._post({"items": []}).status == 400
        assert self._post({}).status == 400
        assert self._post([]).status == 400
