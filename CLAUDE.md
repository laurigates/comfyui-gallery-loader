# CLAUDE.md

ComfyUI custom-node pack with a small Python backend (one node + four
HTTP endpoints) and a single frontend extension (`image-picker.js` +
a reusable `modal-shell.js`). Both halves share a card-grid picker
that targets touch-friendly mobile/tablet use as well as desktop.

## What it does

Three entry points share one picker UI:

1. **`Load Image (Gallery)` node** (`gallery_loader.py` +
   `web/js/gallery_loader.js`) — drop-in `LoadImage` replacement with
   the picker rendered inline on the node body. Cards scroll
   independently of the canvas.
2. **Modal over stock `LoadImage`** (`web/js/image-picker.js`) —
   intercepts the `image` combo widget on `LoadImage`,
   `LoadImageMask`, `LoadImageOutput`. Source tabs for **Input /
   Output / Temp**; commits annotated values (`foo.png [output]`)
   that core's `folder_paths.get_annotated_filepath` resolves
   transparently.
3. **VHS path-loader integration** (`web/js/image-picker.js`) —
   detects nodes whose `STRING` widget has `vhs_path_extensions`
   (`VHS_LoadImagePath`, `VHS_LoadImagesPath`, `VHS_LoadVideoPath`,
   `VHS_LoadVideoFFmpegPath`). Adds a `📁 Browse` button that opens
   the modal in path-mode, rooted at `folder_paths.base_path`.
   Commits raw absolute paths. Directory loaders get a footer
   "Use this folder" button.

## File layout

| Path | Purpose |
|------|---------|
| `__init__.py` | Loader stub. Exports `NODE_CLASS_MAPPINGS`, `NODE_DISPLAY_NAME_MAPPINGS`, `WEB_DIRECTORY="./web"`. |
| `gallery_loader.py` | `GalleryLoadImage` node + four HTTP endpoints (`/gallery_loader/{list,base,thumb,file}`). |
| `web/js/gallery_loader.js` | Inline-grid frontend for the `GalleryLoadImage` node. |
| `web/js/image-picker.js` | Modal picker for stock `LoadImage` + VHS path loaders. |
| `web/js/modal-shell.js` | Reusable modal dialog: backdrop, dialog, toolbar, search, body, footer, ESC, single-modal discipline. |
| `web/js/modal-fuzzy.js` | fzf-lite fuzzy matcher used by the modal's filter input. |
| `web/css/gallery_loader.css` | Inline-grid styles. (The modal injects its own `<style>` from `image-picker.js`.) |
| `pyproject.toml` | Comfy Registry metadata. `PublisherId` and `version` are the fields you'd touch. |
| `.github/workflows/publish.yml` | Auto-publish on `pyproject.toml` version bump. |
| `.github/workflows/ci.yml` | CI: ruff, biome, pytest, gitleaks. |
| `.pre-commit-config.yaml` | Pre-commit hooks: ruff, biome, gitleaks, file hygiene. |
| `biome.json` | Biome (JS/JSON) lint + format config. |
| `tests/` | pytest suite for the Python backend. |
| `justfile` | `lint`, `test`, `format`, `check` recipes. |
| `RELEASE-CHECKLIST.md` | One-time and per-release publish steps. |

## Hard rules

### No new Python dependencies

The Python backend uses ComfyUI-bundled libraries only (`aiohttp`,
`numpy`, `torch`, `PIL`, plus `folder_paths`/`node_helpers`/`server`
from ComfyUI core). `pyproject.toml` declares only
`comfyui-frontend-package>=1.40` — the frontend hook floor. Don't
add `requests`, `httpx`, `pydantic`, etc. If a feature needs a
non-bundled library, design it as an optional companion pack.

### Pack directory name is part of the URL

`web/js/image-picker.js` is served at
`/extensions/comfyui-gallery-loader/js/image-picker.js`. Renaming
the pack directory breaks every fetch the frontend makes. Don't.

### Arbitrary-path endpoints are extension-whitelisted

`/gallery_loader/thumb` and `/gallery_loader/file` accept an absolute
`path` query parameter. They both enforce an extension whitelist
(images for `thumb`, images + common video formats for `file`). When
adding new file types, widen the whitelist explicitly — never read
arbitrary paths without the extension gate.

### Value contract: don't churn input/ workflows

When committing from the modal:

| Source | Committed value | Backward compat |
|---|---|---|
| Input | `subdir/foo.png` (bare relative) | Matches core `LoadImage` exactly. |
| Output | `subdir/foo.png [output]` | Resolved by `get_annotated_filepath`. |
| Temp | `subdir/foo.png [temp]` | Same. |
| VHS path | `/abs/path/foo.png` | Raw absolute, matches VHS expectation. |

Don't switch the Input source to annotated form — existing workflows
serialize bare relative paths and would churn on save/reload.

### Frontend hook is version-sensitive

The modal opens via two strategies:

- **A**: `widget.onPointerDown` patch — requires modern frontend's
  click hook (`comfyui-frontend-package >= 1.40`).
- **B**: explicit `📁 Browse` button widget — guaranteed regardless
  of frontend version.

Strategy B is the safety net. If A breaks (e.g. frontend renames the
hook), the button still works. Don't remove the button widget.

## Dev workflow

### Setup

```sh
uv sync --group dev          # install ruff, pytest, pre-commit
pre-commit install
```

### Lint & format

```sh
uv run ruff check .
uv run ruff format .
npx @biomejs/biome check .
npx @biomejs/biome check --write .
```

### Tests

```sh
uv run pytest -v             # full backend suite
npm test                     # JS pure-helper suite (Vitest)
just test                    # both, the local CI gate
```

### JavaScript tests

The Vitest harness covers the pure helpers in `web/js/modal-fuzzy.js`
(`fuzzyScore`, `fuzzyRank`). DOM-dependent code in `modal-shell.js`,
`image-picker.js`, and `gallery_loader.js` is **not** unit-tested —
it's covered by the smoke matrix below. See `docs/trps/regression-gaps-initial-scaffold.md` for
the rationale and the trigger conditions for promoting DOM coverage.

Test files live under `tests/js/` and follow `*.test.js`. The
`tests/js/__mocks__/app.js` stub is wired through `vitest.config.js`
so picker-module tests can import the ComfyUI `app` without a real
frontend. The fuzzy-matcher tests don't need that hook today.

```sh
npm test                     # one-shot run (CI mode)
npm run test:watch           # watch mode for TDD
```

Note: `package.json` and `node_modules/` are **dev-only**. Nothing
under `node_modules/` is served to ComfyUI.

### Iterating on JS / CSS

**No ComfyUI restart needed** for changes under `web/`. Hard-refresh
the browser tab (Ctrl+Shift+R / Cmd+Shift+R). Changes to
`gallery_loader.py` (backend node, endpoints) **do** require a
restart:

```sh
sudo -n systemctl restart comfyui.service
```

### Endpoint reachability check

```sh
curl -s -o /dev/null -w "%{http_code}\n" \
  http://127.0.0.1:8188/extensions/comfyui-gallery-loader/js/image-picker.js
# Expected: 200

curl -s http://127.0.0.1:8188/gallery_loader/base | jq .
# Expected: { ok: true, base_path: "...", input_dir: "...", ... }
```

### Smoke matrix when changing the picker

After non-trivial frontend changes, verify in browser:

| Node | Expected |
|---|---|
| `LoadImage` | Tabs (Input/Output/Temp); selecting from Output commits `foo.png [output]`. |
| `GalleryLoadImage` | Inline grid renders on the node; switching source chips still works. |
| `VHS_LoadImagePath` | 📁 button opens path-mode modal at base dir; selecting a file commits absolute path. |
| `VHS_LoadImagesPath` | 📁 button opens modal in directory mode; footer "Use this folder" commits the absolute dir. |
| `VHS_LoadVideoPath` | Same as image path, with video poster thumbs. |

## Releases

See `RELEASE-CHECKLIST.md` for the full playbook. High level:

- Semver in `pyproject.toml` — patch for backend fixes, minor for UI
  features, major for breaking endpoint or value-format changes.
- Push to `main` with a version bump → `Comfy-Org/publish-node-action`
  auto-publishes to Comfy Registry.

## Things not to do

- **Don't read arbitrary paths without the extension whitelist.** The
  `/thumb` and `/file` endpoints are the security perimeter; widen
  the allowed extensions explicitly.
- **Don't break the value contract** for the Input source (bare
  relative form). It's how existing workflows serialize.
- **Don't add a Python dependency.** Backend libs must be the ones
  ComfyUI core already ships.
- **Don't rename the pack directory.** It's in the served URL.
- **Don't remove the explicit `📁 Browse` button.** It's the
  Strategy-B safety net for frontend changes.
