"""Regression guard for the ComfyUI package-import path.

ComfyUI imports each custom-node pack as a *package* (``custom_nodes.<pack>``)
and does **not** add the pack directory to ``sys.path``. gallery_loader must
therefore import its sibling ``xmp_meta`` relatively. A bare top-level
``import xmp_meta`` raises ``ModuleNotFoundError`` under that import style —
which silently dropped the whole pack (node + frontend extension) at load
time. The pytest environment hides the bug because ``pythonpath = ["."]``
keeps the pack dir on ``sys.path``, so this test removes it to mimic ComfyUI.
"""

from __future__ import annotations

import importlib
import pathlib
import sys
import types

ROOT = pathlib.Path(__file__).resolve().parent.parent


def test_gallery_loader_imports_sibling_relatively():
    pkg_name = "_glr_package_import_probe"
    saved_path = list(sys.path)
    saved_modules = {k: sys.modules[k] for k in ("gallery_loader", "xmp_meta") if k in sys.modules}
    # Simulate ComfyUI: the pack dir is not on sys.path as a top-level root,
    # so an absolute ``import xmp_meta`` cannot resolve.
    sys.path[:] = [p for p in sys.path if pathlib.Path(p or ".").resolve() != ROOT]
    for name in ("gallery_loader", "xmp_meta"):
        sys.modules.pop(name, None)
    pkg = types.ModuleType(pkg_name)
    pkg.__path__ = [str(ROOT)]
    sys.modules[pkg_name] = pkg
    try:
        # Must not raise ModuleNotFoundError on the sibling import.
        importlib.import_module(f"{pkg_name}.gallery_loader")
    finally:
        sys.path[:] = saved_path
        for name in (
            f"{pkg_name}.gallery_loader",
            f"{pkg_name}.xmp_meta",
            pkg_name,
            "gallery_loader",
            "xmp_meta",
        ):
            sys.modules.pop(name, None)
        sys.modules.update(saved_modules)
