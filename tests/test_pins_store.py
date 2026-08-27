"""Tests for the shared pin store (pins_store.py) and this pack's /pins wiring.

`pins_store` is pure stdlib with no ComfyUI imports, so everything above the
`PinResolution` class runs bare — which is the point of keeping the mutation
helpers pure. The resolution tests below do need the pack's sandbox helpers, so
they monkeypatch `folder_paths.get_directory_by_type` at a tmp_path the same way
`tests/test_helpers.py` does.

This file is the canonical copy; `comfyui-image-browser` mirrors it against its
own module, because the store is the CONTRACT the two packs share (they share a
file, not a build-time dependency, so there is no cross-pack suite to write).
"""

from __future__ import annotations

import asyncio
import json
import os
from types import SimpleNamespace
from typing import ClassVar

import pytest

import gallery_loader
import gallery_loader as gl
import pins_store


def dir_pin(type_name="output", subfolder="keep", **extra):
    return {"kind": "dir", "type": type_name, "subfolder": subfolder, **extra}


def file_pin(name="a.png", type_name="output", subfolder="2026-08-04", **extra):
    return {"kind": "file", "type": type_name, "subfolder": subfolder, "name": name, **extra}


class TestNormalizePin:
    def test_accepts_a_folder_pin(self):
        assert pins_store.normalize_pin(dir_pin()) == {
            "kind": "dir",
            "type": "output",
            "subfolder": "keep",
        }

    def test_accepts_a_file_pin(self):
        assert pins_store.normalize_pin(file_pin()) == {
            "kind": "file",
            "type": "output",
            "subfolder": "2026-08-04",
            "name": "a.png",
        }

    def test_accepts_a_root_level_pin(self):
        assert pins_store.normalize_pin(dir_pin(subfolder=""))["subfolder"] == ""

    def test_missing_subfolder_reads_as_root(self):
        assert pins_store.normalize_pin({"kind": "dir", "type": "input"})["subfolder"] == ""

    @pytest.mark.parametrize("type_name", ["path", "models", "", None, 3])
    def test_rejects_non_sandboxed_type(self, type_name):
        """`type=path` is the load-bearing case: pins address sandboxed roots
        only, exactly like every write in both packs (ADR-0002). The store
        refuses to HOLD one, so a path pin can never reach a resolver."""
        assert pins_store.normalize_pin(dir_pin(type_name=type_name)) is None
        assert pins_store.normalize_pin(file_pin(type_name=type_name)) is None

    @pytest.mark.parametrize("kind", ["folder", "", None, "DIR"])
    def test_rejects_unknown_kind(self, kind):
        assert pins_store.normalize_pin({**dir_pin(), "kind": kind}) is None

    @pytest.mark.parametrize("subfolder", ["../etc", "a/../../b", "/abs/path", 7, ["a"]])
    def test_rejects_traversing_or_absolute_subfolder(self, subfolder):
        assert pins_store.normalize_pin(dir_pin(subfolder=subfolder)) is None

    def test_normalizes_separators_and_redundant_segments(self):
        pin = pins_store.normalize_pin(dir_pin(subfolder="a\\b//c/./"))
        assert pin is not None
        assert pin["subfolder"] == "a/b/c"

    @pytest.mark.parametrize("name", [None, "", ".", "..", "a/b.png", "a\\b.png", 5])
    def test_file_pin_needs_a_bare_name(self, name):
        assert pins_store.normalize_pin(file_pin(name=name)) is None

    def test_folder_pin_ignores_a_name(self):
        assert "name" not in pins_store.normalize_pin(dir_pin(name="stray.png"))

    def test_rejects_a_non_object(self):
        for raw in (None, "output", ["output"], 3):
            assert pins_store.normalize_pin(raw) is None

    def test_preserves_unknown_keys(self):
        """The store is SHARED — a field a newer pack added must survive a
        round-trip through an older one, or the older pack's next add silently
        corrupts the newer one's data."""
        pin = pins_store.normalize_pin(file_pin(note="from the future", rank=3))
        assert pin["note"] == "from the future"
        assert pin["rank"] == 3


class TestPinKey:
    def test_a_folder_and_a_file_at_one_address_are_different_pins(self):
        assert pins_store.pin_key({"kind": "dir", "type": "output", "subfolder": "keep"}) != (
            pins_store.pin_key({"kind": "file", "type": "output", "subfolder": "", "name": "keep"})
        )

    def test_ignores_unknown_keys(self):
        a = pins_store.normalize_pin(file_pin())
        b = pins_store.normalize_pin(file_pin(note="x"))
        assert pins_store.pin_key(a) == pins_store.pin_key(b)


class TestAddPin:
    def test_appends(self):
        pins, err = pins_store.add_pin([], dir_pin())
        assert err == ""
        assert pins == [{"kind": "dir", "type": "output", "subfolder": "keep"}]

    def test_does_not_mutate_the_input_list(self):
        original: list[dict] = []
        pins, _ = pins_store.add_pin(original, dir_pin())
        assert original == []
        assert len(pins) == 1

    def test_adding_an_existing_pin_is_a_no_op_not_an_error(self):
        """The localStorage migration replays every old pin as an add, and two
        devices may migrate independently — a second run must not fail."""
        pins, _ = pins_store.add_pin([], dir_pin())
        again, err = pins_store.add_pin(pins, dir_pin())
        assert err == ""
        assert len(again) == 1

    def test_rejects_an_invalid_pin(self):
        pins, err = pins_store.add_pin([], dir_pin(type_name="path"))
        assert err == "invalid pin"
        assert pins == []

    def test_reports_the_cap_rather_than_silently_refusing(self):
        pins = [
            {"kind": "file", "type": "output", "subfolder": "", "name": f"{i}.png"}
            for i in range(pins_store.MAX_PINS)
        ]
        out, err = pins_store.add_pin(pins, file_pin(name="one-too-many.png", subfolder=""))
        assert "max" in err and str(pins_store.MAX_PINS) in err
        assert len(out) == pins_store.MAX_PINS

    def test_at_the_cap_a_duplicate_add_still_succeeds(self):
        """Otherwise a full list makes re-pinning something already pinned look
        like a failure."""
        pins = [
            {"kind": "file", "type": "output", "subfolder": "", "name": f"{i}.png"}
            for i in range(pins_store.MAX_PINS)
        ]
        _out, err = pins_store.add_pin(pins, file_pin(name="0.png", subfolder=""))
        assert err == ""


class TestRemovePin:
    def test_removes_the_matching_pin_only(self):
        pins = [pins_store.normalize_pin(dir_pin()), pins_store.normalize_pin(file_pin())]
        out, err = pins_store.remove_pin(pins, file_pin())
        assert err == ""
        assert out == [pins_store.normalize_pin(dir_pin())]

    def test_removing_something_absent_is_a_no_op(self):
        out, err = pins_store.remove_pin([], dir_pin())
        assert err == ""
        assert out == []

    def test_rejects_an_invalid_pin(self):
        _out, err = pins_store.remove_pin([], {"kind": "nope"})
        assert err == "invalid pin"


class TestPruneMissing:
    def test_splits_on_the_predicate(self):
        keep = pins_store.normalize_pin(dir_pin())
        drop = pins_store.normalize_pin(file_pin())
        kept, dropped = pins_store.prune_missing([keep, drop], lambda p: p["kind"] == "dir")
        assert kept == [keep]
        assert dropped == [drop]


class TestApplyDelta:
    def test_dispatches_add_and_remove(self):
        pins, err = pins_store.apply_delta([], "add", dir_pin())
        assert err == "" and len(pins) == 1
        pins, err = pins_store.apply_delta(pins, "remove", dir_pin())
        assert err == "" and pins == []

    def test_prune_uses_the_injected_existence_check(self):
        pins = [pins_store.normalize_pin(dir_pin()), pins_store.normalize_pin(file_pin())]
        out, err = pins_store.apply_delta(pins, "prune", None, exists=lambda p: p["kind"] == "dir")
        assert err == ""
        assert out == [pins_store.normalize_pin(dir_pin())]

    def test_prune_without_an_existence_check_is_an_error_not_a_wipe(self):
        pins = [pins_store.normalize_pin(dir_pin())]
        out, err = pins_store.apply_delta(pins, "prune", None)
        assert err
        assert out == pins

    @pytest.mark.parametrize("op", ["set", "", None, "PUT", 3])
    def test_rejects_an_unknown_op(self, op):
        out, err = pins_store.apply_delta([], op, dir_pin())
        assert "add, remove or prune" in err
        assert out == []


class TestLoadPins:
    def test_missing_file_reads_as_empty(self, tmp_path):
        assert pins_store.load_pins(str(tmp_path / "nope.json")) == []

    @pytest.mark.parametrize(
        "body",
        ['{"version": 1, "pins": [', "not json at all", "[]", '"a string"', '{"pins": 3}', ""],
    )
    def test_corrupt_or_wrong_shape_degrades_to_empty_without_raising(self, tmp_path, body):
        """A convenience index must not be able to stop the gallery opening."""
        p = tmp_path / "comfy-pins.json"
        p.write_text(body, encoding="utf-8")
        assert pins_store.load_pins(str(p)) == []

    def test_one_bad_row_does_not_take_the_rest_with_it(self, tmp_path):
        p = tmp_path / "comfy-pins.json"
        p.write_text(
            json.dumps(
                {
                    "version": 1,
                    "pins": [
                        {"kind": "dir", "type": "path", "subfolder": "/etc"},
                        {"kind": "dir", "type": "output", "subfolder": "keep"},
                        "garbage",
                        {"kind": "file", "type": "input", "subfolder": "", "name": "../x.png"},
                    ],
                }
            ),
            encoding="utf-8",
        )
        assert pins_store.load_pins(str(p)) == [
            {"kind": "dir", "type": "output", "subfolder": "keep"}
        ]

    def test_deduplicates_and_caps(self, tmp_path):
        p = tmp_path / "comfy-pins.json"
        raw = [dir_pin()] * 3 + [
            {"kind": "file", "type": "output", "subfolder": "", "name": f"{i}.png"}
            for i in range(pins_store.MAX_PINS + 10)
        ]
        p.write_text(json.dumps({"version": 1, "pins": raw}), encoding="utf-8")
        loaded = pins_store.load_pins(str(p))
        assert len(loaded) == pins_store.MAX_PINS
        keys = [pins_store.pin_key(x) for x in loaded]
        assert len(set(keys)) == len(keys)

    def test_tolerates_an_unknown_version(self, tmp_path):
        p = tmp_path / "comfy-pins.json"
        p.write_text(json.dumps({"version": 99, "pins": [dir_pin()]}), encoding="utf-8")
        assert len(pins_store.load_pins(str(p))) == 1


class TestSavePins:
    def test_round_trips(self, tmp_path):
        p = str(tmp_path / "comfy-pins.json")
        pins = [pins_store.normalize_pin(dir_pin()), pins_store.normalize_pin(file_pin())]
        pins_store.save_pins(p, pins)
        assert pins_store.load_pins(p) == pins
        with open(p, encoding="utf-8") as f:
            assert json.load(f)["version"] == pins_store.PINS_VERSION

    def test_creates_the_user_directory_if_absent(self, tmp_path):
        p = str(tmp_path / "fresh" / "comfy-pins.json")
        pins_store.save_pins(p, [pins_store.normalize_pin(dir_pin())])
        assert os.path.isfile(p)

    def test_leaves_no_temp_file_behind(self, tmp_path):
        p = str(tmp_path / "comfy-pins.json")
        pins_store.save_pins(p, [pins_store.normalize_pin(dir_pin())])
        assert [e.name for e in os.scandir(tmp_path)] == ["comfy-pins.json"]

    def test_a_failed_write_keeps_the_previous_list_and_cleans_up(self, tmp_path, monkeypatch):
        """Non-atomic writes lose the whole list on a crash mid-write; this is
        the assertion that the temp-then-rename is actually doing its job."""
        p = str(tmp_path / "comfy-pins.json")
        pins_store.save_pins(p, [pins_store.normalize_pin(dir_pin())])

        def boom(_src, _dst):
            raise OSError("disk full")

        monkeypatch.setattr(pins_store.os, "replace", boom)
        with pytest.raises(OSError):
            pins_store.save_pins(p, [pins_store.normalize_pin(file_pin())])
        assert pins_store.load_pins(p) == [pins_store.normalize_pin(dir_pin())]
        assert [e.name for e in os.scandir(tmp_path)] == ["comfy-pins.json"]


class TestPinsPath:
    def test_both_packs_land_on_one_file(self):
        """The shared filename IS the cross-pack mechanism — same role
        thumb_cache.CACHE_DIR_NAME plays for thumbnails."""
        assert pins_store.PINS_FILE_NAME == "comfy-pins.json"
        assert pins_store.pins_path("/u") == os.path.join("/u", "comfy-pins.json")


class TestPinResolution:
    """The pack's own resolver + entry builder, against a real tmp sandbox."""

    def _sandbox(self, base, monkeypatch):
        import folder_paths

        monkeypatch.setattr(
            folder_paths, "get_directory_by_type", lambda t: str(base), raising=False
        )

    def test_a_present_folder_resolves_and_exists(self, tmp_path, monkeypatch):
        self._sandbox(tmp_path, monkeypatch)
        (tmp_path / "keep").mkdir()
        entry = gl._pin_entry(pins_store.normalize_pin(dir_pin(subfolder="keep")))
        assert entry["exists"] is True

    def test_a_missing_folder_is_reported_not_dropped(self, tmp_path, monkeypatch):
        self._sandbox(tmp_path, monkeypatch)
        entry = gl._pin_entry(pins_store.normalize_pin(dir_pin(subfolder="gone")))
        assert entry["exists"] is False
        assert entry["subfolder"] == "gone"

    def test_a_present_file_carries_the_listing_stats(self, tmp_path, monkeypatch):
        self._sandbox(tmp_path, monkeypatch)
        (tmp_path / "d").mkdir()
        (tmp_path / "d" / "a.png").write_bytes(b"not really a png")
        entry = gl._pin_entry(pins_store.normalize_pin(file_pin(subfolder="d")))
        assert entry["exists"] is True
        # The same keys /list emits per file — that is what lets the pinned view
        # render through the ordinary grid with no special-casing.
        for key in ("name", "mtime", "size", "ext", "rating"):
            assert key in entry
        assert entry["ext"] == ".png"

    def test_a_moved_file_is_reported_missing_rather_than_vanishing(self, tmp_path, monkeypatch):
        self._sandbox(tmp_path, monkeypatch)
        entry = gl._pin_entry(pins_store.normalize_pin(file_pin(subfolder="d")))
        assert entry["exists"] is False
        assert entry["name"] == "a.png"

    def test_a_directory_masquerading_as_a_file_pin_does_not_read_as_present(
        self, tmp_path, monkeypatch
    ):
        self._sandbox(tmp_path, monkeypatch)
        (tmp_path / "a.png").mkdir()
        entry = gl._pin_entry(pins_store.normalize_pin(file_pin(name="a.png", subfolder="")))
        assert entry["exists"] is False

    def test_a_non_media_file_pin_is_not_addressable(self, tmp_path, monkeypatch):
        self._sandbox(tmp_path, monkeypatch)
        (tmp_path / "secrets.txt").write_text("nope", encoding="utf-8")
        pin = pins_store.normalize_pin(file_pin(name="secrets.txt", subfolder=""))
        assert gl._resolve_pin(pin) is None
        assert gl._pin_entry(pin)["exists"] is False

    def test_prune_drops_only_the_missing(self, tmp_path, monkeypatch):
        self._sandbox(tmp_path, monkeypatch)
        (tmp_path / "here").mkdir()
        pins = [
            pins_store.normalize_pin(dir_pin(subfolder="here")),
            pins_store.normalize_pin(dir_pin(subfolder="gone")),
        ]
        kept, _ = pins_store.apply_delta(pins, "prune", None, exists=gl._pin_exists)
        assert [p["subfolder"] for p in kept] == ["here"]


class TestPinsEndpoints:
    """The two handlers end to end — the seam the two frontends actually hit.

    Driven through the conftest's stubbed `web.json_response`, which returns a
    plain object carrying the body, so the delta grammar and the response shape
    are asserted rather than merely reachable. `just check` cannot see a
    frontend/backend contract bug any other way (see comfyui-pack-live-smoke).
    """

    def _wire(self, tmp_path, monkeypatch):
        import folder_paths

        monkeypatch.setattr(
            folder_paths, "get_directory_by_type", lambda t: str(tmp_path), raising=False
        )
        monkeypatch.setattr(
            folder_paths, "get_user_directory", lambda: str(tmp_path / "user"), raising=False
        )

    def _get(self):
        return asyncio.run(gallery_loader.gallery_pins_get(SimpleNamespace()))._body

    def _post(self, body):
        class _Req:
            # The Content-Type guard on every mutating POST route answers 415
            # before the handler runs — see tests/test_write_containment.py.
            headers: ClassVar[dict[str, str]] = {"Content-Type": "application/json"}

            async def json(self):
                return body

        return asyncio.run(gallery_loader.gallery_pins_post(_Req()))

    def test_get_is_empty_before_anything_is_pinned(self, tmp_path, monkeypatch):
        self._wire(tmp_path, monkeypatch)
        assert self._get() == {"ok": True, "pins": [], "max": pins_store.MAX_PINS}

    def test_add_then_get_round_trips_through_the_file(self, tmp_path, monkeypatch):
        self._wire(tmp_path, monkeypatch)
        (tmp_path / "d").mkdir()
        (tmp_path / "d" / "a.png").write_bytes(b"x")
        resp = self._post({"op": "add", "item": file_pin(subfolder="d")})
        assert resp._body["ok"] is True
        # The POST answers with the whole resolved list, so no follow-up GET is
        # needed — and a separate GET must agree with it.
        assert resp._body["pins"] == self._get()["pins"]
        [entry] = self._get()["pins"]
        assert entry["exists"] is True
        assert entry["kind"] == "file"
        assert entry["type"] == "output"
        assert entry["ext"] == ".png"

    def test_the_delta_is_idempotent(self, tmp_path, monkeypatch):
        self._wire(tmp_path, monkeypatch)
        self._post({"op": "add", "item": dir_pin()})
        resp = self._post({"op": "add", "item": dir_pin()})
        assert resp._body["ok"] is True
        assert len(resp._body["pins"]) == 1

    def test_remove_drops_it(self, tmp_path, monkeypatch):
        self._wire(tmp_path, monkeypatch)
        self._post({"op": "add", "item": dir_pin()})
        resp = self._post({"op": "remove", "item": dir_pin()})
        assert resp._body["pins"] == []

    def test_a_missing_pin_is_reported_not_dropped(self, tmp_path, monkeypatch):
        """ "It moved" and "you never pinned it" must not look alike — the
        frontend renders the former dimmed with an unpin affordance."""
        self._wire(tmp_path, monkeypatch)
        (tmp_path / "d").mkdir()
        (tmp_path / "d" / "a.png").write_bytes(b"x")
        self._post({"op": "add", "item": file_pin(subfolder="d")})
        (tmp_path / "d" / "a.png").unlink()
        [entry] = self._get()["pins"]
        assert entry["exists"] is False
        assert entry["name"] == "a.png"

    def test_prune_drops_the_missing_and_keeps_the_rest(self, tmp_path, monkeypatch):
        self._wire(tmp_path, monkeypatch)
        (tmp_path / "here").mkdir()
        self._post({"op": "add", "item": dir_pin(subfolder="here")})
        self._post({"op": "add", "item": dir_pin(subfolder="gone")})
        resp = self._post({"op": "prune"})
        assert [p["subfolder"] for p in resp._body["pins"]] == ["here"]

    def test_a_path_pin_is_refused_at_the_endpoint(self, tmp_path, monkeypatch):
        self._wire(tmp_path, monkeypatch)
        resp = self._post({"op": "add", "item": dir_pin(type_name="path")})
        assert resp.status == 400
        assert resp._body["ok"] is False
        assert self._get()["pins"] == []

    @pytest.mark.parametrize("body", [{"op": "set", "item": {}}, {}, {"op": None}, {"item": {}}])
    def test_an_unknown_op_is_a_400_not_a_wipe(self, tmp_path, monkeypatch, body):
        self._wire(tmp_path, monkeypatch)
        self._post({"op": "add", "item": dir_pin()})
        resp = self._post(body)
        assert resp.status == 400
        assert len(self._get()["pins"]) == 1

    def test_the_cap_is_reported_to_the_caller(self, tmp_path, monkeypatch):
        """The UI is expected to SAY it hit the cap; an add that silently
        vanishes reads as a broken button."""
        self._wire(tmp_path, monkeypatch)
        monkeypatch.setattr(pins_store, "MAX_PINS", 2)
        self._post({"op": "add", "item": dir_pin(subfolder="a")})
        self._post({"op": "add", "item": dir_pin(subfolder="b")})
        resp = self._post({"op": "add", "item": dir_pin(subfolder="c")})
        assert resp.status == 400
        assert "max 2" in resp._body["error"]

    def test_the_store_lands_on_the_shared_filename(self, tmp_path, monkeypatch):
        """Both packs join PINS_FILE_NAME onto the user dir — that shared path
        IS the cross-pack and cross-device mechanism."""
        self._wire(tmp_path, monkeypatch)
        self._post({"op": "add", "item": dir_pin()})
        assert os.path.isfile(tmp_path / "user" / "comfy-pins.json")
