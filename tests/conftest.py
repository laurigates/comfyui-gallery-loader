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

import pytest


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


def _stub_response(*, body=None, status=200, headers=None, content_type=None, **kwargs):
    """Stand in for aiohttp's web.Response.

    The sibling of _stub_json_response for the two endpoints that do NOT answer
    with JSON: /thumb (WebP bytes, or a bodiless 304) and /file's error ladder.
    Without it those handlers hand back a MagicMock — callable, but with no
    inspectable status, body or headers — so the conditional-request logic and
    the extension whitelist could not be asserted at all. That is the blocker
    #14 named, still standing after the JSON half of the harness landed.

    Keyword-only, matching the real Response, so a call that drifts to a
    positional body fails here instead of silently binding to the wrong field.
    `headers` is materialised into a plain dict: the real Response copies the
    mapping, so a test reading the handler's own dict object back would be
    reading its own write rather than the response.
    """
    return SimpleNamespace(
        status=status,
        body=body,
        headers=dict(headers or {}),
        content_type=content_type,
        path=None,
    )


def _stub_file_response(path, *, status=200, headers=None, **kwargs):
    """Stand in for aiohttp's web.FileResponse.

    `path` is POSITIONAL, as gallery_file calls it — the file is never opened
    here, so the assertion available to a test is which path was addressed
    plus the headers that went with it.
    """
    return SimpleNamespace(
        status=status,
        body=None,
        headers=dict(headers or {}),
        content_type=None,
        path=str(path),
    )


sys.modules["aiohttp"].web.Response = _stub_response
sys.modules["aiohttp"].web.FileResponse = _stub_file_response


class FakeGetRequest:
    """Stand-in for a GET aiohttp.web.Request.

    Carries `.headers` as well as `.rel_url.query`, which the `_FakeGetRequest`
    in tests/test_helpers.py does not: /list never reads a header, /thumb reads
    If-None-Match off one. A conditional-request test written against the
    headerless class would take the unconditional branch and pass whether or
    not the 304 short-circuit existed.
    """

    def __init__(self, query=None, headers=None):
        self.rel_url = SimpleNamespace(query=dict(query or {}))
        self.headers = dict(headers or {})


@pytest.fixture
def get_request():
    """The FakeGetRequest class itself — tests construct their own per call."""
    return FakeGetRequest


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
