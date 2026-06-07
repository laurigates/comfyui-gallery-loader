"""Unit tests for pure helpers in gallery_loader.py.

Heavy and ComfyUI-internal imports are stubbed by conftest.py, so this
module can run in a vanilla Python environment.
"""

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
