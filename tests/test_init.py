"""Sanity checks for __init__.py without exec'ing it (the relative
import would require packaging the pack dir, which isn't worth the
ceremony for a re-export shim).
"""

import pathlib

ROOT = pathlib.Path(__file__).resolve().parent.parent
INIT_SRC = (ROOT / "__init__.py").read_text()


def test_init_declares_web_directory_pointing_at_dist():
    # The frontend is built from src/ to web/dist/ via `bun build`; ComfyUI
    # serves that tree as the extension root. See ADR-0010.
    assert 'WEB_DIRECTORY = "./web/dist"' in INIT_SRC


def test_init_reexports_node_mappings():
    # Mappings come from gallery_loader; __init__ just re-exports them.
    assert "NODE_CLASS_MAPPINGS" in INIT_SRC
    assert "NODE_DISPLAY_NAME_MAPPINGS" in INIT_SRC


def test_init_includes_web_directory_in_all():
    assert '"WEB_DIRECTORY"' in INIT_SRC
