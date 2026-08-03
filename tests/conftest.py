"""Stub heavy and ComfyUI-internal imports so gallery_loader.py can be
imported in a vanilla Python environment for unit tests.

Stubbed:
- numpy, torch, aiohttp, PIL — heavy or unavailable in CI runners.
- folder_paths, node_helpers, server — ComfyUI internals only present
  when running inside a ComfyUI install.

The PromptServer.instance.routes.get(path) decorator is wired
explicitly so the module-level @decorator calls in gallery_loader
return their wrapped function unchanged.
"""

from __future__ import annotations

import sys
from types import ModuleType, SimpleNamespace
from unittest.mock import MagicMock


class _StubModule(ModuleType):
    def __getattr__(self, attr: str):
        if attr.startswith("__"):
            raise AttributeError(attr)
        m = MagicMock()
        setattr(self, attr, m)
        return m


def _ensure_stub(name: str) -> ModuleType:
    if name in sys.modules and not isinstance(sys.modules[name], _StubModule):
        return sys.modules[name]
    m = _StubModule(name)
    sys.modules[name] = m
    return m


# Heavy / unavailable third-party
for _name in ("numpy", "torch", "aiohttp"):
    _ensure_stub(_name)

# PIL is a package with submodules
_pil = _ensure_stub("PIL")
for _sub in ("Image", "ImageOps", "ImageSequence"):
    setattr(_pil, _sub, _ensure_stub(f"PIL.{_sub}"))

# aiohttp.web — gallery_loader uses `from aiohttp import web`.
sys.modules["aiohttp"].web = _ensure_stub("aiohttp.web")


def _stub_json_response(body, status: int = 200, **kwargs):
    """Stand in for aiohttp's web.json_response.

    Without this, _StubModule hands back a MagicMock whose return value has no
    inspectable body, so a handler can be CALLED but nothing about its response
    can be asserted. Endpoint-level tests (the recursive listing) need the body,
    so return a plain object carrying it.
    """
    return SimpleNamespace(status=status, _body=body)


sys.modules["aiohttp"].web.json_response = _stub_json_response

# ComfyUI internals
_ensure_stub("folder_paths")
_ensure_stub("node_helpers")
_server = _ensure_stub("server")


class _NoopRoutes:
    """Decorator-shaped no-op for @PromptServer.instance.routes.get(path)."""

    def get(self, path):
        def deco(fn):
            return fn

        return deco

    def post(self, path):
        return self.get(path)


# PromptServer.instance.routes is read at module load; supply a real
# object so attribute access doesn't trigger _StubModule's MagicMock path.
_server.PromptServer = SimpleNamespace(instance=SimpleNamespace(routes=_NoopRoutes()))
