---
id: ADR-0004
created: 2026-05-28
status: Accepted
domain: api-design
relates-to: [PRD-001, ADR-0002]
---

# Static HTTP Endpoint Surface + Extension Whitelist as Security Perimeter

## Status

Accepted

## Context

The picker needs server-side filesystem access for two reasons core ComfyUI doesn't satisfy:

1. **Arbitrary-path listings** for VHS path-mode (`folder_paths.base_path` and below). Core `/api/view` only serves `input/output/temp` subtrees.
2. **Arbitrary-path media streaming** for video previews. `/api/view` rejects absolute paths.

These needs require new endpoints. Endpoints that accept an absolute-path query parameter are a security surface — without constraints, they would expose every readable file on disk to anyone able to reach the ComfyUI HTTP server.

## Decision

Four HTTP endpoints under `/gallery_loader/`, with extension-whitelist gating on the two that accept absolute paths:

| Endpoint | Accepts | Guard |
|---|---|---|
| `/gallery_loader/list` | `type=input/output/temp` or `type=path&path=<abs>` | `commonpath` check for sandboxed types; no extension filter for `type=path` since it returns metadata only, not file contents |
| `/gallery_loader/base` | (no params) | Returns ComfyUI's well-known dirs; read-only metadata |
| `/gallery_loader/thumb` | `path=<abs>` | `IMG_EXTS` whitelist; encodes 512×512 WebP; never returns raw file bytes |
| `/gallery_loader/file` | `path=<abs>` | `STREAMABLE_EXTS = IMG_EXTS ∪ VIDEO_EXTS` whitelist; streams raw bytes |

The extension whitelist is the security perimeter. When adding a new file type:
- Widen `IMG_EXTS` / `VIDEO_EXTS` / `STREAMABLE_EXTS` explicitly in `gallery_loader.py`.
- Never read arbitrary paths without the extension gate.

## Consequences

- **Positive**: arbitrary-path reads are gated by file extension. An attacker hitting `/gallery_loader/file?path=/etc/passwd` gets a 403.
- **Positive**: easy to test — `tests/test_helpers.py` covers the parse / resolution / whitelist logic without a running server.
- **Positive**: clear documentation point in CLAUDE.md and `.claude/rules/api-conventions.md` — every contributor sees the gate.
- **Negative**: the whitelist is a maintenance burden — new formats need a code edit, not config. Acceptable; new formats are rare and "explicit code change to widen the perimeter" is the desired posture.
- **Negative**: ComfyUI's HTTP server is shared across all installed packs. A pack's endpoints inherit ComfyUI's overall network posture (typically `127.0.0.1` only). If ComfyUI is exposed externally, these endpoints are too — same caveat as every custom node.
