---
id: PRD-001
created: 2026-05-28
modified: 2026-05-28
status: Active
version: "1.0"
relates-to: []
github-issues: []
name: blueprint-derive-prd
---

# comfyui-gallery-loader — Product Requirements Document

## Executive Summary

### Problem Statement

ComfyUI's stock `LoadImage` widget is a text-typed dropdown of every file under `input/`, with no thumbnails, no separation by source (input vs output vs temp), and no touch-friendly UX. On a tablet or phone, picking an image from a workflow is painful. On any device, picking a freshly-rendered image from `output/` requires switching widgets or copy-pasting paths.

VHS (Video Helper Suite) path loaders (`VHS_LoadImagePath`, `VHS_LoadImagesPath`, `VHS_LoadVideoPath`, `VHS_LoadVideoFFmpegPath`) accept absolute filesystem paths via a bare `STRING` widget. There is no built-in file browser — users type paths by hand or paste them from elsewhere.

### Proposed Solution

A ComfyUI custom-node pack (`comfyui-gallery-loader`) with three entry points sharing one card-grid picker UI:

1. **`Load Image (Gallery)` node** — drop-in `LoadImage` replacement that renders the picker inline on the node body. Cards scroll independently of the canvas.
2. **Modal over stock `LoadImage`** — intercepts the `image` combo widget on `LoadImage`, `LoadImageMask`, `LoadImageOutput`. Source tabs for Input / Output / Temp. Commits the standard annotated-value strings (`foo.png [output]`) that core's `folder_paths.get_annotated_filepath` resolves transparently.
3. **VHS path-loader integration** — detects VHS path widgets and adds a `📁 Browse` button that opens the same modal in path-mode rooted at `folder_paths.base_path`. Commits raw absolute paths.

The pack is a card-grid picker first, with the file-browser semantics underneath. The grid is touch-optimized — large thumbnails, large touch targets, no iOS auto-zoom on the filter input.

### Business Impact

- **Touch-first workflows** — tablets and phones become viable ComfyUI clients for picking inputs.
- **Faster output-driven flows** — pick the image you just rendered without copy-pasting filenames.
- **No more typing paths** — VHS path loaders gain the file browser they always needed.
- **Workflow stability** — the value-format contract is unchanged from core / VHS, so the picker is invisible to saved workflows.

---

## Stakeholders & Personas

### Stakeholder Matrix

| Role | Name/Team | Responsibility | Contact |
|------|-----------|----------------|---------|
| Author / Maintainer | Lauri Gates | Feature development, releases | GitHub: @laurigates |
| ComfyUI Core | Comfy-Org | Frontend API stability, folder_paths semantics | comfyui-frontend-package |
| VHS Pack | Kosinkadink | `vhs_path_extensions` widget convention | comfyui-vhs |
| Comfy Registry | Comfy-Org | Distribution channel | registry.comfy.org |

### User Personas

#### Primary: ComfyUI Tablet / Touch User

- **Needs**: pick images for workflows without typing paths or scrolling cramped dropdowns.
- **Pain Points**: stock LoadImage dropdown mispositions on zoomed/panned canvases; iOS auto-zooms text inputs.
- **Goals**: tap a thumbnail to load an image.

#### Secondary: Iterative Generation User (Desktop)

- **Needs**: feed the image they just rendered into the next workflow step.
- **Pain Points**: `output/` files aren't in the LoadImage dropdown by default; copy-pasting filenames between widgets is brittle.
- **Goals**: switch the source tab to Output and click the just-rendered image.

#### Tertiary: VHS Path-Loader User

- **Needs**: load a video or image sequence by browsing the filesystem.
- **Pain Points**: VHS path widgets are bare STRING inputs — no browser.
- **Goals**: click 📁 and pick the file/directory; commit goes as raw absolute path.

---

## Functional Requirements

### Core Features

| ID | Feature | Description | Priority |
|----|---------|-------------|----------|
| FR-001 | `GalleryLoadImage` node with inline card grid | Drop-in LoadImage replacement; picker renders inline on the node. | P0 |
| FR-002 | Modal picker over stock LoadImage | Intercept `image` combo on LoadImage*. Source tabs Input/Output/Temp. | P0 |
| FR-003 | VHS path-loader integration | Detect `vhs_path_extensions` widgets; add 📁 Browse button opening path-mode modal. | P0 |
| FR-004 | fzf-lite fuzzy filter | Picker rows filtered by filter input via fuzzy matching. | P0 |
| FR-005 | HTTP endpoints (`/list`, `/base`, `/thumb`, `/file`) | Backend serves listings, well-known dirs, thumbnails, and arbitrary-path file streams. | P0 |
| FR-006 | Value-format contract per source | Input → bare relative; Output/Temp → annotated; VHS → raw absolute. | P0 |
| FR-007 | Touch-friendly modal UX | pointerdown-based dismiss, touch-action: manipulation, large touch targets. | P1 |
| FR-008 | Frontend Hook Strategy A + B | onPointerDown patch + explicit Browse button safety net. | P0 |
| FR-009 | Static asset serving | `WEB_DIRECTORY="./web"`; pack dir name part of URL. | P0 |

### User Stories

- As a tablet user, I want to tap a thumbnail to pick an image instead of typing or scrolling a dropdown.
- As an iterative-generation user, I want to switch to the Output tab and pick the image I just rendered.
- As a VHS user, I want to click 📁 next to the path field and browse the filesystem to pick a video file.
- As a workflow maintainer, I want the picker to commit the same value formats that core / VHS expect, so saved workflows don't churn.

---

## Non-Functional Requirements

### Performance

- Listing requests are O(directory entries). Thumbnails are pre-cached by browsers (`Cache-Control: private, max-age=300` on `/thumb`).
- No per-pick server round-trip on workflow execution — the resolved value is committed to the widget, and `IS_CHANGED` hashes mtime+size locally for cache validity.
- Frontend JS is split across four ES modules (~600 LOC total), no bundler, no build step.

### Security

- `/thumb` and `/file` enforce an extension whitelist (`IMG_EXTS` / `STREAMABLE_EXTS`) before reading from disk. Arbitrary-path reads are gated by file extension.
- `/list` for `type=input/output/temp` is constrained to the configured root via `os.path.commonpath` check (no `..` escape).
- No external network egress; no telemetry.

### Accessibility

- Filter input minimum 16px font (no iOS auto-zoom).
- Backdrop / dialog elements have `touch-action: manipulation` to disable double-tap zoom.
- Keyboard-complete: filter input typeable from anywhere; cards selectable by click/tap.

### Compatibility

- **ComfyUI frontend**: `comfyui-frontend-package >= 1.40` for `widget.onPointerDown` (Strategy A). Strategy B (explicit button) works without it.
- **Python**: `>= 3.10` (ComfyUI minimum).
- **Browsers**: any modern browser supported by ComfyUI's Vue frontend.

---

## Technical Considerations

### Architecture

```
__init__.py                              # Loader stub — exports node mappings + WEB_DIRECTORY
gallery_loader.py                        # GalleryLoadImage node + 4 HTTP endpoints
web/
  js/
    gallery_loader.js                    # Inline-grid for GalleryLoadImage
    image-picker.js                      # Modal over stock LoadImage + VHS path nodes
    modal-shell.js                       # Reusable modal dialog primitive
    modal-fuzzy.js                       # fzf-lite fuzzy matcher (pure helpers)
  css/
    gallery_loader.css                   # Inline-grid styles
```

**Extension registration**: `app.registerExtension` with `nodeCreated` + `loadedGraphNode` lifecycle hooks.

**HTTP surface**: four `PromptServer.instance.routes.get(...)` decorators on async aiohttp handlers in `gallery_loader.py`. No external client; called by the frontend.

**Reuse axis**: `modal-shell.js` and `modal-fuzzy.js` are deliberately self-contained — no picker-specific concerns leak in. They could be extracted to a shared frontend-only pack in the future (see comment at `modal-fuzzy.js:10`).

### Dependencies

| Dependency | Role | Version Floor |
|-----------|------|---------------|
| comfyui-frontend-package | Frontend runtime (widget hooks, Vue, LiteGraph) | >= 1.40 |
| ComfyUI-bundled libs (`aiohttp`, `numpy`, `torch`, `PIL`, `folder_paths`) | Backend | — |

No new Python runtime dependencies.

### Integration Points

| System | Integration | Notes |
|--------|------------|-------|
| ComfyUI frontend | `widget.onPointerDown` (intercept) | Strategy A; version-sensitive |
| ComfyUI frontend | Custom widget (`📁 Browse` button) | Strategy B; version-agnostic safety net |
| ComfyUI frontend | `app.registerExtension` API | Standard extension entry point |
| ComfyUI backend | `folder_paths.get_annotated_filepath` (read) | Resolves annotated values for Output/Temp |
| ComfyUI backend | `PromptServer.instance.routes` (write) | Custom HTTP endpoint registration |
| VHS pack | `widget.options.vhs_path_extensions` (read) | Detection signal for path-mode integration |
| Comfy Registry | `pyproject.toml [tool.comfy]` + GitHub Actions `publish.yml` | Auto-publish on version bump |

---

## Success Metrics

| Metric | Target |
|--------|--------|
| Stock `LoadImage` value format unchanged | 100% workflow compatibility on save/reload |
| Picker open latency (cold) | < 100ms typical |
| Picker open latency (warm) | < 30ms typical |
| Extension whitelist coverage | All image + common video formats |
| Tablet usability | Picker dismissable, touch-target hits register |

---

## Scope

### In Scope

- `GalleryLoadImage` node with inline card grid.
- Modal over stock `LoadImage`, `LoadImageMask`, `LoadImageOutput`.
- VHS path-loader integration for the four documented widget types.
- Source tabs for Input / Output / Temp.
- Path-mode listing rooted at `folder_paths.base_path`.
- Image thumbnails via `/gallery_loader/thumb`.
- Video preview streaming via `/gallery_loader/file`.
- GitHub Actions auto-publish to Comfy Registry on `pyproject.toml` version bump.

### Out of Scope

- Editing images inside the picker (crop, rotate, etc.).
- Multi-select picking (one workflow value at a time).
- Server-side image transformations beyond the thumbnail endpoint.
- Custom widget types other than `image` (combo) and VHS `STRING` path widgets.
- Sharing thumbnails / files across ComfyUI instances.

---

## Timeline & Phases

### Current Phase: Initial Release (v0.1.0)

Feature-complete for the three entry points and the four endpoints. Pending:
- Comfy Registry publisher registration (`PublisherId` in `pyproject.toml`).
- ComfyUI Manager `custom-node-list.json` PR.
