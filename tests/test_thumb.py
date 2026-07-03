"""Tests for the /thumb target resolver and the shared thumb_cache module.

Heavy and ComfyUI-internal imports are stubbed by conftest.py (PIL included),
so encoding is monkeypatched — the cache/store/prune logic is pure stdlib.
"""

import os

import folder_paths  # the conftest stub

import gallery_loader
import thumb_cache

# ---------- _resolve_thumb_target -----------------------------------


def test_resolve_thumb_target_path_mode_normalizes():
    path, err = gallery_loader._resolve_thumb_target({"path": "/tmp/../tmp/x.png"})
    assert err == ""
    assert path == "/tmp/x.png"


def test_resolve_thumb_target_requires_path_without_type():
    path, err = gallery_loader._resolve_thumb_target({})
    assert path is None
    assert "missing path" in err


def test_resolve_thumb_target_sandboxed_resolves_under_root(tmp_path, monkeypatch):
    monkeypatch.setattr(
        folder_paths, "get_directory_by_type", lambda t: str(tmp_path), raising=False
    )
    path, err = gallery_loader._resolve_thumb_target(
        {"type": "output", "subfolder": "sub", "name": "a.png"}
    )
    assert err == ""
    assert path == str(tmp_path / "sub" / "a.png")


def test_resolve_thumb_target_sandboxed_rejects_traversal_name(tmp_path, monkeypatch):
    monkeypatch.setattr(
        folder_paths, "get_directory_by_type", lambda t: str(tmp_path), raising=False
    )
    for bad in ("../a.png", "a/b.png", "..", ".", ""):
        path, err = gallery_loader._resolve_thumb_target({"type": "input", "name": bad})
        assert path is None, bad
        assert "invalid name" in err


def test_resolve_thumb_target_sandboxed_rejects_subfolder_escape(tmp_path, monkeypatch):
    root = tmp_path / "root"
    root.mkdir()
    monkeypatch.setattr(folder_paths, "get_directory_by_type", lambda t: str(root), raising=False)
    path, err = gallery_loader._resolve_thumb_target(
        {"type": "temp", "subfolder": "../outside", "name": "a.png"}
    )
    assert path is None
    assert "escapes root" in err


# ---------- thumb_cache ----------------------------------------------


def _stat_for(p):
    return os.stat(p)


def test_cache_key_changes_with_mtime(tmp_path):
    f = tmp_path / "img.png"
    f.write_bytes(b"one")
    k1 = thumb_cache.cache_key(str(f), _stat_for(f))
    os.utime(f, ns=(1, 1))
    k2 = thumb_cache.cache_key(str(f), _stat_for(f))
    assert k1 != k2


def test_etag_is_quoted_cache_key(tmp_path):
    f = tmp_path / "img.png"
    f.write_bytes(b"x")
    st = _stat_for(f)
    assert thumb_cache.etag_for(str(f), st) == f'"{thumb_cache.cache_key(str(f), st)}"'


def test_get_thumb_serves_seeded_cache_without_encoding(tmp_path, monkeypatch):
    src = tmp_path / "img.png"
    src.write_bytes(b"pixels")
    cache_dir = tmp_path / "cache"
    cache_dir.mkdir()
    st = _stat_for(src)
    seeded = b"CACHED-WEBP"
    (cache_dir / f"{thumb_cache.cache_key(str(src), st)}.webp").write_bytes(seeded)

    def boom(_path):
        raise AssertionError("encode_thumb must not run on a cache hit")

    monkeypatch.setattr(thumb_cache, "encode_thumb", boom)
    assert thumb_cache.get_thumb(str(src), st, str(cache_dir)) == seeded


def test_get_thumb_encodes_and_stores_on_miss(tmp_path, monkeypatch):
    src = tmp_path / "img.png"
    src.write_bytes(b"pixels")
    cache_dir = tmp_path / "cache"  # not created — _store must makedirs
    st = _stat_for(src)
    monkeypatch.setattr(thumb_cache, "encode_thumb", lambda _p: b"ENCODED")
    assert thumb_cache.get_thumb(str(src), st, str(cache_dir)) == b"ENCODED"
    stored = cache_dir / f"{thumb_cache.cache_key(str(src), st)}.webp"
    assert stored.read_bytes() == b"ENCODED"
    # No stray temp files left behind by the atomic write.
    assert [p.name for p in cache_dir.iterdir()] == [stored.name]


def test_get_thumb_returns_none_when_encode_fails(tmp_path, monkeypatch):
    src = tmp_path / "img.png"
    src.write_bytes(b"pixels")
    cache_dir = tmp_path / "cache"
    monkeypatch.setattr(thumb_cache, "encode_thumb", lambda _p: None)
    assert thumb_cache.get_thumb(str(src), _stat_for(src), str(cache_dir)) is None
    assert not cache_dir.exists()


def test_prune_drops_oldest_beyond_cap(tmp_path):
    for i in range(5):
        p = tmp_path / f"{i}.webp"
        p.write_bytes(b"x")
        os.utime(p, ns=(i * 1_000_000_000, i * 1_000_000_000))
    thumb_cache.prune(str(tmp_path), max_entries=2)
    assert sorted(p.name for p in tmp_path.iterdir()) == ["3.webp", "4.webp"]
