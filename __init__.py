"""comfyui-gallery-loader — mobile-friendly Load Image with a card grid.

See gallery_loader.py for the backend and web/js/gallery_loader.js for
the frontend extension.
"""

try:
    # ComfyUI loads custom_nodes as packages — relative import works.
    from .gallery_loader import NODE_CLASS_MAPPINGS, NODE_DISPLAY_NAME_MAPPINGS
except ImportError:
    # Pytest imports __init__.py without a package context; fall back
    # to absolute (the pack root is on sys.path via pyproject's
    # `pythonpath = ["."]`).
    from gallery_loader import NODE_CLASS_MAPPINGS, NODE_DISPLAY_NAME_MAPPINGS

WEB_DIRECTORY = "./web"

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS", "WEB_DIRECTORY"]
