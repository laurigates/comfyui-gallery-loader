"""Absolute-path reads stop at ComfyUI's own directories (issue #121).

Registry moderation flagged 0.1.31 as ``arbitrary-file-read``. The finding was
accurate: ``type=path`` (ADR-0004) let any caller who could reach the port
list any directory on the host and read any media file in it —
``/list?type=path``, ``/file?path=``, ``/thumb?path=``, ``/metadata?path=`` —
and the ``GalleryLoadImage`` node loaded any absolute path a /prompt named.
ComfyUI ships no authentication, so "can reach the port" includes everyone on
the LAN of a ``--listen 0.0.0.0`` install and a DNS-rebound page in the user's
own browser.

The reach is now ComfyUI's own directories: base_path, input/output/temp/user,
and every folder registered in ``folder_paths`` (models, custom_nodes, and
anything the operator lists in ``extra_model_paths.yaml``). An operator who
wants another directory browsable registers it there or symlinks it inside
the tree; both need the server's filesystem, which no HTTP route grants. A
ComfyUI setting would not do: settings are writable by any caller through
core's unauthenticated ``POST /settings/{id}``.

Every refusal is pinned next to the acceptance of a path differing only in
whether it is inside the reach, so none of these pass against a handler that
refuses everything.
"""

from __future__ import annotations

import asyncio
import os

import folder_paths
import pytest

import gallery_loader
import thumb_cache

# Every refusal names how an operator widens the reach.
HINT = "extra_model_paths.yaml"


def _call(handler, request):
    return asyncio.run(handler(request))


@pytest.fixture
def layout(tmp_path, monkeypatch):
    """A ComfyUI tree and a sibling 'home' directory outside it."""
    comfy = tmp_path / "comfy"
    models = tmp_path / "models-elsewhere" / "checkpoints"
    home = tmp_path / "home" / "Pictures"
    for d in (comfy / "input", comfy / "output", models, home):
        d.mkdir(parents=True)
    for d in (comfy / "input", models, home):
        (d / "photo.png").write_bytes(b"\x89PNG fake")
    monkeypatch.setattr(folder_paths, "base_path", str(comfy), raising=False)
    monkeypatch.setattr(
        folder_paths, "get_input_directory", lambda: str(comfy / "input"), raising=False
    )
    monkeypatch.setattr(
        folder_paths,
        "folder_names_and_paths",
        {"checkpoints": ([str(models)], {".safetensors"})},
        raising=False,
    )
    monkeypatch.setattr(thumb_cache, "encode_thumb", lambda *a, **k: b"RIFF-webp", raising=False)
    # Keep the thumbnail cache in tmp: the stubbed get_user_directory() is a
    # MagicMock, and its str() would otherwise become a directory in the repo.
    monkeypatch.setattr(gallery_loader, "_thumb_cache_dir", lambda: str(tmp_path / "thumbs"))
    return {"comfy": comfy, "models": models, "home": home, "tmp": tmp_path}


# ---------------------------------------------------------------------------
# The reach predicate itself
# ---------------------------------------------------------------------------


def test_comfy_dirs_and_registered_model_folders_are_inside(layout):
    assert gallery_loader._within_read_roots(str(layout["comfy"] / "custom_nodes" / "x.png"))
    assert gallery_loader._within_read_roots(str(layout["models"] / "photo.png"))


def test_a_directory_outside_every_root_is_outside(layout):
    assert not gallery_loader._within_read_roots(str(layout["home"] / "photo.png"))
    assert not gallery_loader._within_read_roots("/etc/passwd")


def test_a_lexical_escape_from_a_root_is_outside(layout):
    escape = os.path.join(
        str(layout["comfy"]), "input", "..", "..", "home", "Pictures", "photo.png"
    )
    assert not gallery_loader._within_read_roots(escape)


def test_a_sibling_that_only_shares_a_name_prefix_is_outside(layout):
    # commonpath, not startswith: /x/comfy-private is not inside /x/comfy.
    evil = layout["tmp"] / "comfy-private"
    evil.mkdir()
    assert not gallery_loader._within_read_roots(str(evil / "photo.png"))


def test_an_operator_symlink_inside_the_tree_is_followed(layout):
    # The documented escape hatch: the check is lexical, so a link the
    # operator placed under ComfyUI (no HTTP route creates one) is in reach.
    link = layout["comfy"] / "input" / "photos"
    link.symlink_to(layout["home"], target_is_directory=True)
    assert gallery_loader._within_read_roots(str(link / "photo.png"))


@pytest.mark.parametrize("bad", [None, "", ".", "relative/dir", 42])
def test_unusable_folder_paths_entries_admit_nothing(layout, monkeypatch, bad):
    # A relative entry would resolve against the server's cwd — never a root.
    monkeypatch.chdir(layout["home"])
    monkeypatch.setattr(
        folder_paths, "folder_names_and_paths", {"odd": ([bad], set())}, raising=False
    )
    assert not gallery_loader._within_read_roots(str(layout["home"] / "photo.png"))


def test_no_usable_root_at_all_refuses_everything(layout, monkeypatch):
    for attr in ("base_path", "get_input_directory", "folder_names_and_paths"):
        monkeypatch.delattr(folder_paths, attr, raising=False)
    assert not gallery_loader._within_read_roots(str(layout["comfy"] / "input" / "photo.png"))


# ---------------------------------------------------------------------------
# The four read endpoints
# ---------------------------------------------------------------------------


def test_list_refuses_a_directory_outside_the_reach(layout, get_request):
    resp = _call(
        gallery_loader.gallery_list, get_request({"type": "path", "path": str(layout["home"])})
    )
    assert resp.status == 403
    assert HINT in resp._body["error"]


def test_list_serves_a_directory_inside_the_reach(layout, get_request):
    resp = _call(
        gallery_loader.gallery_list,
        get_request({"type": "path", "path": str(layout["comfy"] / "input")}),
    )
    assert resp.status == 200
    assert [f["name"] for f in resp._body["files"]] == ["photo.png"]


def test_file_refuses_outside_and_is_no_existence_oracle(layout, get_request):
    present = _call(
        gallery_loader.gallery_file, get_request({"path": str(layout["home"] / "photo.png")})
    )
    absent = _call(
        gallery_loader.gallery_file, get_request({"path": str(layout["home"] / "absent.png")})
    )
    assert present.status == 403
    assert absent.status == 403


def test_file_serves_inside(layout, get_request):
    resp = _call(
        gallery_loader.gallery_file, get_request({"path": str(layout["models"] / "photo.png")})
    )
    assert resp.status == 200


def test_thumb_refuses_outside_and_serves_inside(layout, get_request):
    outside = _call(
        gallery_loader.gallery_thumb, get_request({"path": str(layout["home"] / "photo.png")})
    )
    inside = _call(
        gallery_loader.gallery_thumb,
        get_request({"path": str(layout["comfy"] / "input" / "photo.png")}),
    )
    assert outside.status == 403
    assert inside.status == 200


def test_metadata_refuses_outside_and_serves_inside(layout, get_request):
    outside = _call(
        gallery_loader.gallery_metadata,
        get_request({"type": "path", "path": str(layout["home"] / "photo.png")}),
    )
    inside = _call(
        gallery_loader.gallery_metadata,
        get_request({"type": "path", "path": str(layout["comfy"] / "input" / "photo.png")}),
    )
    assert outside.status == 403
    assert inside.status == 200


def test_a_folder_registered_in_folder_paths_opens_the_endpoints(layout, get_request, monkeypatch):
    # What an extra_model_paths.yaml entry turns into at runtime.
    monkeypatch.setattr(
        folder_paths,
        "folder_names_and_paths",
        {"photos": ([str(layout["home"])], set())},
        raising=False,
    )
    resp = _call(
        gallery_loader.gallery_file, get_request({"path": str(layout["home"] / "photo.png")})
    )
    assert resp.status == 200


# ---------------------------------------------------------------------------
# The node: /prompt can name a path too
# ---------------------------------------------------------------------------


def test_node_refuses_an_absolute_path_outside_the_reach(layout):
    with pytest.raises(ValueError, match=HINT):
        gallery_loader._resolve_input_string(str(layout["home"] / "photo.png"))
    msg = gallery_loader.GalleryLoadImage.VALIDATE_INPUTS(str(layout["home"] / "photo.png"))
    assert isinstance(msg, str) and HINT in msg


def test_node_accepts_an_absolute_path_inside_the_reach(layout):
    path = str(layout["models"] / "photo.png")
    assert gallery_loader._resolve_input_string(path) == path
    assert gallery_loader.GalleryLoadImage.VALIDATE_INPUTS(path) is True


def test_node_refuses_an_annotated_path_that_traverses_out(layout, monkeypatch):
    # The widget is a STRING, so core's combo "value not in list" check never
    # runs; get_annotated_filepath joins the traversal straight onto input/.
    monkeypatch.setattr(
        folder_paths,
        "get_annotated_filepath",
        lambda v: os.path.join(str(layout["comfy"] / "input"), v.rsplit(" [", 1)[0]),
        raising=False,
    )
    with pytest.raises(ValueError, match=HINT):
        gallery_loader._resolve_input_string("../../home/Pictures/photo.png [input]")
    assert gallery_loader._resolve_input_string("photo.png [input]") == os.path.join(
        str(layout["comfy"] / "input"), "photo.png"
    )
