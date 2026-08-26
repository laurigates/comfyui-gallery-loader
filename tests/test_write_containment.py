"""The metadata WRITE path is contained to input/output/temp.

Why this file exists: ``_resolve_write_target`` resolved its address through
``_resolve_listing_base``, which accepts ``type=path`` and hands back
``os.path.abspath(os.path.expanduser(...))`` with no root to check against.
That is the READ posture (/file and /thumb are deliberately arbitrary-path
reads behind an extension gate) and it must not be the WRITE posture: an XMP
write rewrites an existing file in place, and a sidecar write CREATES
``<path>.xmp`` wherever it is pointed. Reachable unauthenticated, and — until
the Content-Type guard below — reachable cross-origin from a plain
``<form enctype="text/plain">``.

Every rejection here is paired with the acceptance of a request that differs
ONLY in the thing under test. A lone negative passes just as happily against a
resolver wired to refuse everything, which is precisely the state this file
must be able to tell apart from a correct one.
"""

from __future__ import annotations

import ast
import asyncio
import os
import struct
import zlib
from pathlib import Path
from types import SimpleNamespace

import folder_paths  # the conftest stub
import pytest

import gallery_loader
import xmp_meta

JSON_HEADERS = {"Content-Type": "application/json"}


def _call(handler, request):
    return asyncio.run(handler(request))


def _get_request(query):
    """Stand-in for a GET request — /list reads only .rel_url.query."""
    return SimpleNamespace(rel_url=SimpleNamespace(query=query), headers={})


def _chunk(ctype: bytes, data: bytes) -> bytes:
    body = ctype + data
    return struct.pack(">I", len(data)) + body + struct.pack(">I", zlib.crc32(body) & 0xFFFFFFFF)


def _png() -> bytes:
    """A minimal valid 1x1 PNG (the same shape tests/test_xmp.py builds)."""
    ihdr = struct.pack(">IIBBBBB", 1, 1, 8, 2, 0, 0, 0)
    return (
        xmp_meta.PNG_SIG
        + _chunk(b"IHDR", ihdr)
        + _chunk(b"IDAT", zlib.compress(b"\x00\xff\x00\x00"))
        + _chunk(b"IEND", b"")
    )


class _SandboxBase:
    """Wires every sandboxed root at ``tmp_path/root`` and seeds a PNG in it."""

    def _sandbox(self, tmp_path, monkeypatch):
        root = tmp_path / "root"
        root.mkdir(exist_ok=True)
        monkeypatch.setattr(
            folder_paths, "get_directory_by_type", lambda t: str(root), raising=False
        )
        return root

    def _seed(self, directory, name="victim.png"):
        """A real 1x1 PNG, so the XMP writer rewrites it IN PLACE.

        A container the writer cannot open would fall through to the sidecar
        and the in-place arm of these tests would assert nothing.
        """
        path = Path(directory) / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(_png())
        return path


# ---------------------------------------------------------------------------
# The resolver
# ---------------------------------------------------------------------------


class TestWriteResolverContainment(_SandboxBase):
    def test_type_path_is_refused_while_the_same_file_under_output_is_accepted(
        self, tmp_path, monkeypatch
    ):
        """The vulnerability and its control, on ONE file.

        Both arms address the same bytes on disk and differ only in ``type``,
        so a resolver that refused everything would fail the second assertion
        and a resolver that accepted everything would fail the first.
        """
        root = self._sandbox(tmp_path, monkeypatch)
        self._seed(root)

        refused, err, status = gallery_loader._resolve_write_target(
            {"type": "path", "subfolder": "", "path": str(root), "name": "victim.png"}
        )
        assert refused is None
        assert err == "writes are only allowed in input/output/temp"
        assert status == 400

        allowed, err, status = gallery_loader._resolve_write_target(
            {"type": "output", "subfolder": "", "path": "", "name": "victim.png"}
        )
        assert allowed == str(root / "victim.png")
        assert err == ""
        assert status == 200

    def test_an_unknown_type_is_refused_by_the_same_gate(self, tmp_path, monkeypatch):
        self._sandbox(tmp_path, monkeypatch)
        _, err, _ = gallery_loader._resolve_write_target(
            {"type": "models", "subfolder": "", "path": "", "name": "victim.png"}
        )
        assert err == "writes are only allowed in input/output/temp"

    @pytest.mark.parametrize(
        "name",
        [
            "../victim.png",
            "../../etc/victim.png",
            "sub/victim.png",
            "/etc/victim.png",
            "\u2024\u2024/victim.png",  # ONE DOT LEADER homoglyphs, real slash
            ".",
            "..",
        ],
    )
    def test_a_non_bare_name_is_refused_while_the_bare_one_is_accepted(
        self, tmp_path, monkeypatch, name
    ):
        """Assert WHICH gate refused, not merely that something did.

        Three of these names are refused by the containment check or by the
        404 further down even with the bare-name gate deleted, so an
        ``err != ""`` assertion here would be satisfied by a different check
        and the deletion would go unnoticed. Measured: with ``_is_bare_name``
        forced True, ``sub/victim.png`` resolves cleanly and only the
        subsequent ``isfile`` refuses it.
        """
        root = self._sandbox(tmp_path, monkeypatch)
        self._seed(root)
        (root / "sub").mkdir(exist_ok=True)
        self._seed(root / "sub")
        _, err = gallery_loader._resolve_sandboxed_file("output", "", name)
        assert err == "invalid name"
        # Same call, bare name: proves the gate discriminates rather than
        # refusing every request that reaches it.
        target, err = gallery_loader._resolve_sandboxed_file("output", "", "victim.png")
        assert (err, target) == ("", str(root / "victim.png"))

    @pytest.mark.parametrize(
        "name",
        [
            "..%2fvictim.png",
            "%2e%2e%2fvictim.png",
            "..%5cvictim.png",
            "\u2024\u2024%2fvictim.png",
        ],
    )
    def test_an_encoded_separator_stays_a_filename_and_never_becomes_a_path(
        self, tmp_path, monkeypatch, name
    ):
        """These are BARE names, and the correct answer is to accept them
        as filenames inside the root — `%2f` is three characters, not a
        separator. What must never happen is a resolver that decodes them and
        then walks out, so the assertion is on the resolved target's location
        rather than on a refusal. Pinning "refused" here would be wrong AND
        would go green against a decode-then-escape resolver that happened to
        404.
        """
        root = self._sandbox(tmp_path, monkeypatch)
        target, err = gallery_loader._resolve_sandboxed_file("output", "", name)
        assert err == ""
        assert target is not None
        assert os.path.dirname(target) == str(root)
        assert os.path.basename(target) == name

    def test_a_non_media_extension_is_refused_while_a_media_one_is_accepted(
        self, tmp_path, monkeypatch
    ):
        root = self._sandbox(tmp_path, monkeypatch)
        (root / "notes.txt").write_bytes(b"x")
        self._seed(root)
        _, err, _ = gallery_loader._resolve_write_target(
            {"type": "output", "subfolder": "", "path": "", "name": "notes.txt"}
        )
        assert err == "unsupported file type"
        _, err, _ = gallery_loader._resolve_write_target(
            {"type": "output", "subfolder": "", "path": "", "name": "victim.png"}
        )
        assert err == ""

    def test_a_subfolder_that_traverses_out_is_refused_while_a_real_one_is_accepted(
        self, tmp_path, monkeypatch
    ):
        root = self._sandbox(tmp_path, monkeypatch)
        self._seed(root / "real")
        _, err, _ = gallery_loader._resolve_write_target(
            {"type": "output", "subfolder": "../..", "path": "", "name": "victim.png"}
        )
        assert err == "subfolder escapes root"
        target, err, _ = gallery_loader._resolve_write_target(
            {"type": "output", "subfolder": "real", "path": "", "name": "victim.png"}
        )
        assert (err, target) == ("", str(root / "real" / "victim.png"))


class TestSymlinkedSubfolder(_SandboxBase):
    """The second, independent gate.

    ``os.path.abspath`` is purely textual: it collapses ``..`` and joins, and
    knows nothing about symlinks. A link inside the root therefore satisfies
    the lexical containment check while resolving to a destination outside it.
    ``os.path.realpath`` is what closes that, and it belongs on the mutation
    resolver ONLY — see ``test_listing_still_follows_a_symlinked_subfolder``.
    """

    def _linked(self, tmp_path, monkeypatch):
        root = self._sandbox(tmp_path, monkeypatch)
        outside = tmp_path / "outside"
        outside.mkdir()
        self._seed(outside)
        os.symlink(str(outside), str(root / "link"))
        return root, outside

    def test_the_lexical_check_alone_would_have_passed_this(self, tmp_path, monkeypatch):
        """Pin the reason the realpath gate is not redundant.

        If this ever fails, ``abspath`` has started resolving links and the
        second gate could be reconsidered — until then it is load-bearing.
        """
        root, _ = self._linked(tmp_path, monkeypatch)
        base = os.path.abspath(os.path.join(str(root), "link"))
        target = os.path.abspath(os.path.join(base, "victim.png"))
        assert os.path.commonpath([target, str(root)]) == str(root)
        assert os.path.commonpath([os.path.realpath(target), os.path.realpath(root)]) != str(
            os.path.realpath(root)
        )

    def test_a_write_through_the_link_is_refused_while_a_real_subfolder_is_accepted(
        self, tmp_path, monkeypatch
    ):
        root, _ = self._linked(tmp_path, monkeypatch)
        self._seed(root / "real")
        _, err, status = gallery_loader._resolve_write_target(
            {"type": "output", "subfolder": "link", "path": "", "name": "victim.png"}
        )
        assert (err, status) == ("name escapes root", 400)
        target, err, _ = gallery_loader._resolve_write_target(
            {"type": "output", "subfolder": "real", "path": "", "name": "victim.png"}
        )
        assert (err, target) == ("", str(root / "real" / "victim.png"))

    def test_listing_still_follows_a_symlinked_subfolder(self, tmp_path, monkeypatch):
        """The READ resolver must NOT gain the realpath gate.

        ``output/renders -> /mnt/nas/renders`` is an ordinary setup; refusing
        to LIST it would break the pack for anyone who keeps their outputs on
        another volume. Containment belongs on the write, where a symlink is
        an escape, not on the read, where it is a filesystem feature.
        """
        self._linked(tmp_path, monkeypatch)
        resp = _call(
            gallery_loader.gallery_list,
            _get_request({"type": "output", "subfolder": "link"}),
        )
        assert resp.status == 200
        assert resp._body.get("ok") is True, resp._body
        names = {f["name"] for f in resp._body["files"]}
        assert "victim.png" in names


# ---------------------------------------------------------------------------
# End to end, through the shipped handlers
# ---------------------------------------------------------------------------


class _FakePostRequest:
    def __init__(self, body, headers=None):
        self._json = body
        self.headers = dict(JSON_HEADERS if headers is None else headers)

    async def json(self):
        return self._json


class TestHandlersRefuseAnOutOfSandboxWrite(_SandboxBase):
    def _outside(self, tmp_path):
        outside = tmp_path / "outside"
        outside.mkdir(exist_ok=True)
        return outside, self._seed(outside)

    def test_rating_neither_rewrites_the_file_nor_drops_a_sidecar_beside_it(
        self, tmp_path, monkeypatch
    ):
        root = self._sandbox(tmp_path, monkeypatch)
        outside, victim = self._outside(tmp_path)
        before = victim.read_bytes()

        resp = _call(
            gallery_loader.gallery_set_rating,
            _FakePostRequest(
                {
                    "type": "path",
                    "path": str(outside),
                    "name": "victim.png",
                    "rating": 5,
                }
            ),
        )
        assert resp.status == 400
        assert victim.read_bytes() == before
        assert not (outside / "victim.png.xmp").exists()

        # Control: the same write, the same bytes, addressed inside the root.
        inside = self._seed(root)
        resp = _call(
            gallery_loader.gallery_set_rating,
            _FakePostRequest(
                {"type": "output", "subfolder": "", "name": "victim.png", "rating": 5}
            ),
        )
        assert resp.status == 200
        assert inside.read_bytes() != before

    def test_tag_is_refused_for_type_path_and_accepted_inside_the_root(
        self, tmp_path, monkeypatch
    ):
        root = self._sandbox(tmp_path, monkeypatch)
        outside, victim = self._outside(tmp_path)
        before = victim.read_bytes()

        resp = _call(
            gallery_loader.gallery_set_tag,
            _FakePostRequest(
                {
                    "type": "path",
                    "path": str(outside),
                    "name": "victim.png",
                    "tag": "nsfw",
                    "present": True,
                }
            ),
        )
        assert resp.status == 400
        assert victim.read_bytes() == before

        self._seed(root)
        resp = _call(
            gallery_loader.gallery_set_tag,
            _FakePostRequest(
                {
                    "type": "output",
                    "subfolder": "",
                    "name": "victim.png",
                    "tag": "nsfw",
                    "present": True,
                }
            ),
        )
        assert resp.status == 200


# ---------------------------------------------------------------------------
# The Content-Type guard on every mutating POST
# ---------------------------------------------------------------------------


MUTATING_PATHS = {
    "/gallery_loader/rating",
    "/gallery_loader/tag",
    "/gallery_loader/pins",
}


class TestJsonContentTypeGuard:
    """aiohttp's ``request.json()`` never inspects Content-Type.

    Verified against the installed aiohttp (3.14.3): ``BaseRequest.json``
    calls ``text()``, which calls ``read()`` and decodes — the header is read
    only for the charset. So a cross-origin
    ``<form enctype="text/plain">`` POST, which is CORS-simple and therefore
    preflight-free, arrives at these handlers with a body the parser accepts.
    Requiring ``application/json`` makes such a request non-simple, so the
    browser must preflight it first.
    """

    def test_the_registry_lists_exactly_the_mutating_routes(self):
        assert set(gallery_loader.MUTATING_POST_ROUTES) == MUTATING_PATHS

    @pytest.mark.parametrize(
        ("name", "path"),
        [
            ("gallery_set_rating", "/gallery_loader/rating"),
            ("gallery_set_tag", "/gallery_loader/tag"),
            ("gallery_pins_post", "/gallery_loader/pins"),
        ],
    )
    def test_the_handler_that_was_REGISTERED_is_the_guarded_one(self, name, path):
        """Without this, the registry can hold a guarded copy of a route that
        was registered unguarded — every 415 assertion below would pass while
        the live route took a text/plain body. Registering ``fn`` instead of
        ``guarded`` is a one-word edit, and this is the only thing that sees
        it: the decorator returns whatever it registered, so the module
        attribute and the registry entry must be the same object.
        """
        assert getattr(gallery_loader, name) is gallery_loader.MUTATING_POST_ROUTES[path]

    @pytest.mark.parametrize("path", sorted(MUTATING_PATHS))
    @pytest.mark.parametrize(
        "ctype",
        [
            None,
            "",
            "text/plain",
            "text/plain;charset=UTF-8",
            "multipart/form-data",
            "application/x-www-form-urlencoded",
            "application/jsonx",
        ],
    )
    def test_a_non_json_content_type_is_415(self, path, ctype):
        handler = gallery_loader.MUTATING_POST_ROUTES[path]
        headers = {} if ctype is None else {"Content-Type": ctype}
        resp = _call(handler, _FakePostRequest({}, headers=headers))
        assert resp.status == 415
        assert resp._body["error"] == "Content-Type must be application/json"

    @pytest.mark.parametrize("path", sorted(MUTATING_PATHS))
    @pytest.mark.parametrize(
        "ctype",
        ["application/json", "application/json; charset=utf-8", "APPLICATION/JSON"],
    )
    def test_a_json_content_type_reaches_the_handler(self, path, ctype, tmp_path, monkeypatch):
        """The other direction, on the same empty body.

        Reaching the handler means the request is answered by the handler's own
        validation (400 "invalid body"/"invalid name"/"unknown op"), never 415.
        A guard that rejected everything would fail here.
        """
        monkeypatch.setattr(
            folder_paths, "get_directory_by_type", lambda t: str(tmp_path), raising=False
        )
        monkeypatch.setattr(
            folder_paths, "get_user_directory", lambda: str(tmp_path / "user"), raising=False
        )
        handler = gallery_loader.MUTATING_POST_ROUTES[path]
        resp = _call(handler, _FakePostRequest({}, headers={"Content-Type": ctype}))
        assert resp.status != 415
        assert resp.status == 400


class TestNoPostRouteBypassesTheGuard:
    """Omission is a build error, not a matter of remembering.

    Both directions are asserted in one place: no handler may carry the raw
    ``routes`` POST decorator, AND the set that carries the guarded one is
    pinned. Without the second assertion the first is satisfied by a module
    with no POST routes at all.
    """

    def _decorated(self):
        tree = ast.parse(Path(gallery_loader.__file__).read_text(encoding="utf-8"))
        bare: list[str] = []
        guarded: list[str] = []
        for node in ast.walk(tree):
            if not isinstance(node, (ast.AsyncFunctionDef, ast.FunctionDef)):
                continue
            for dec in node.decorator_list:
                src = ast.unparse(dec)
                if src.startswith("_mutating_post("):
                    guarded.append(node.name)
                elif ".routes.post(" in src:
                    bare.append(f"{node.name}: @{src}")
        return bare, guarded

    def test_no_handler_registers_a_post_route_directly(self):
        bare, _ = self._decorated()
        assert not bare, (
            "A POST route is registered without the JSON Content-Type guard. "
            "Register it with @_mutating_post(<path>) instead: " + "; ".join(bare)
        )

    def test_every_mutating_handler_carries_the_guard_decorator(self):
        _, guarded = self._decorated()
        assert sorted(guarded) == [
            "gallery_pins_post",
            "gallery_set_rating",
            "gallery_set_tag",
        ]
