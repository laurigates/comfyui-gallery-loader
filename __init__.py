"""comfyui-gallery-loader — mobile-friendly Load Image with a card grid.

See gallery_loader.py for the backend. The frontend is TypeScript in
``src/`` (entry ``src/index.ts``), compiled to ESM via ``bun build`` and
emitted to ``web/dist/``. ComfyUI serves ``WEB_DIRECTORY`` as the
extension root, so the built bundle is at ``web/dist/index.js``. The
shared modal primitives come from ``@laurigates/comfy-modal-kit`` and are
inlined into the bundle. See ADR-0010.
"""

try:
    # ComfyUI loads custom_nodes as packages — relative import works.
    from .gallery_loader import NODE_CLASS_MAPPINGS, NODE_DISPLAY_NAME_MAPPINGS
except ImportError:
    # Pytest imports __init__.py without a package context; fall back
    # to absolute (the pack root is on sys.path via pyproject's
    # `pythonpath = ["."]`).
    from gallery_loader import NODE_CLASS_MAPPINGS, NODE_DISPLAY_NAME_MAPPINGS

WEB_DIRECTORY = "./web/dist"

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS", "WEB_DIRECTORY"]
