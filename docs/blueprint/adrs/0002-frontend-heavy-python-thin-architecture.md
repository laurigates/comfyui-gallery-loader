---
id: ADR-0002
created: 2026-05-28
status: Accepted
domain: frontend-framework
relates-to: [PRD-001, ADR-0001]
---

# Frontend-Heavy + Python-Thin Architecture

## Status

Accepted

## Context

The pack's UX requirements (touch-friendly card grid, modal overlay, fuzzy filter, source tabs) live entirely in the browser. The Python side needs only:

- a custom node definition (`GalleryLoadImage`) so the picker has a "drop-in `LoadImage`" entry point;
- four HTTP endpoints to surface filesystem listings and arbitrary-path media (thumbnails, video previews) that core `/api/view` does not cover (it only serves files under input/output/temp, not arbitrary paths used by VHS).

Comparison reference: sister pack `comfyui-sampler-info` is frontend-only (zero Python nodes, zero endpoints). This pack diverges because the VHS-path integration genuinely needs server-side filesystem access — the browser can't `os.scandir` an arbitrary directory.

## Decision

Frontend-heavy architecture with a deliberately thin Python backend:

- One node class (`GalleryLoadImage`) — ~60 lines.
- Four HTTP endpoints (`/list`, `/base`, `/thumb`, `/file`) — each a single async aiohttp handler with structured JSON responses.
- All UI logic, fuzzy matching, keyboard navigation, modal lifecycle, source-tab state, and value-format adaptation lives in JS.

## Consequences

- **Positive**: Python surface is small enough to be exhaustively tested with pytest (see `tests/test_helpers.py`). Path-resolution, extension-whitelist, and edge cases are covered without a running ComfyUI.
- **Positive**: UI iteration is browser-hard-refresh only. The Python process is restarted only when endpoint behavior changes.
- **Positive**: clear security perimeter — only the four endpoints touch the filesystem, and three of the four enforce an extension whitelist (ADR-0004).
- **Negative**: divergence from sampler-info's frontend-only stance. Acceptable because the use cases differ — sampler-info enriches existing widgets; gallery-loader needs to enumerate the filesystem.
- **Negative**: backend changes need a ComfyUI restart. Not a regression vs core — same constraint applies to every Python node.
