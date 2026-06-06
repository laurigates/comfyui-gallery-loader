---
id: ADR-0001
created: 2026-05-28
status: Superseded
superseded-by: ADR-0010
domain: build-tooling
relates-to: [PRD-001]
---

# Project Language Choice — Python Backend + Vanilla JavaScript Frontend

## Status

Superseded by [ADR-0010](0010-adopt-typescript-bun-build.md) — the frontend
moved from vanilla JavaScript to TypeScript compiled via `bun build`. The
Python-backend half of this decision still holds.

## Context

The pack must integrate with ComfyUI's two-runtime architecture: a Python backend (aiohttp + custom nodes) and a Vue/LiteGraph frontend. Both halves have host APIs that constrain language choice.

- The custom node and HTTP endpoints have to be Python — ComfyUI's node API and `PromptServer.instance.routes` registration accept only Python callables.
- The frontend hooks (`app.registerExtension`, `widget.onPointerDown`) are JavaScript APIs called from the running Vue app. No bundler is supplied; extensions are served as raw JS modules.

## Decision

Use Python 3.10+ for the backend and vanilla JavaScript (ES modules, no transpilation) for the frontend.

- Python backend: `gallery_loader.py` defines `GalleryLoadImage` and four `/gallery_loader/*` endpoints. Uses ComfyUI-bundled libraries only — no new pip deps.
- Frontend: four ES modules in `web/js/`. Served raw at `/extensions/comfyui-gallery-loader/js/`. No webpack, no Vite, no TypeScript at runtime.

## Consequences

- **Positive**: zero build step. Hot-reload on JS edits is browser hard-refresh — no `npm run build` loop. Backend changes need a ComfyUI restart, which is the only place we incur process restart cost.
- **Positive**: pack is trivially installable via `ComfyUI-Manager` clone — no compiled artifacts.
- **Negative**: no TypeScript at runtime. We mitigate with JSDoc annotations on pure helpers (see `modal-fuzzy.js`) and pure-helper unit tests.
- **Negative**: vanilla JS code is verbose vs Vue/TS shorthand. We mitigate with a multi-file split (ADR-0003).
