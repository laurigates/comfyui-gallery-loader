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

## Amendment (2026-10, issue #121): the absolute-path reach stops at ComfyUI's directories

Two premises above did not hold.

**"The extension whitelist is the security perimeter."** The whitelist limits
*what kind* of file is read; it puts no limit on *where*. With it in place,
`/list?type=path` still enumerated any directory on the host, and `/file`,
`/thumb?path=` and `/metadata?path=` still read any photo, video or screenshot
on it. Registry moderation flagged 0.1.31 as `arbitrary-file-read` for that.

**"Typically `127.0.0.1` only."** The pack family is mobile-first, so ComfyUI
commonly listens on `0.0.0.0`, and every LAN device then reaches these routes
without authentication. A loopback bind is still reachable from a DNS-rebound
page in the user's browser, which is same-origin to the browser.

Decision: every absolute-path read (`/list?type=path`, `/file`, `/thumb?path=`,
`/metadata?path=`, and the `GalleryLoadImage` node's resolved path) must lie
inside `_read_roots()`. That is `folder_paths.base_path`, the
input/output/temp/user directories, and every path in
`folder_paths.folder_names_and_paths`. The check runs before any stat, so an
outside path is no existence oracle. Refusals are `403` and name the way to
widen the reach.

- **The widening mechanism is the server's filesystem.** An operator can add a
  folder to `extra_model_paths.yaml`, which adds it to `folder_names_and_paths`,
  or symlink it inside the tree. The check is lexical (`abspath` and
  `commonpath`), so `..` cannot escape while an operator's symlink is followed.
  None of these packs' routes, and none of core's, can create a symlink.
- **Not a ComfyUI setting.** Core's `POST /settings/{id}` lets any caller write
  one, so a setting can be switched on by the same caller it is meant to stop.
  `comfyui-image-browser` gated its reads on a setting (its ADR-0002 amendment)
  and stayed flagged.
- **Not an environment variable.** `os.environ` is one of the scanner
  tripwires `tests/test_publish_hygiene.py` keeps out of shipped code. ComfyUI
  already has a server-side list of directories, and duplicating it would add a
  second source of truth.
- **The node is gated too.** `/prompt` is as unauthenticated as these routes,
  and the widget is a STRING, so core's combo "value not in list" check never
  runs. An annotated `../../x.png [input]` resolved through
  `get_annotated_filepath` to wherever it pointed. The check runs on the
  resolved path, whatever form it took.

Pinned by `tests/test_read_reach.py`. `tests/mutations-read-reach.json` proves
each assertion can fail.
