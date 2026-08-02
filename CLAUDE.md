# CLAUDE.md

ComfyUI custom-node pack with a small Python backend (one node + six
HTTP endpoints) and a TypeScript frontend (`src/`) built to `web/dist/`
via `bun build`. The modal shell + fuzzy matcher come from the shared
`@laurigates/comfy-modal-kit` (inlined into the bundle). Both halves
share a card-grid picker that targets touch-friendly mobile/tablet use
as well as desktop. See ADR-0010 for the TypeScript + bun build decision.

## What it does

Three entry points share one picker UI:

1. **`Load Image (Gallery)` node** (`gallery_loader.py` +
   `src/gallery_loader.ts`) — drop-in `LoadImage` replacement with
   the picker rendered inline on the node body. Cards scroll
   independently of the canvas.
2. **Modal over stock `LoadImage`** (`src/image-picker.ts`) —
   intercepts the `image` combo widget on `LoadImage`,
   `LoadImageMask`, `LoadImageOutput`. Source tabs for **Input /
   Output / Temp**; commits annotated values (`foo.png [output]`)
   that core's `folder_paths.get_annotated_filepath` resolves
   transparently.
3. **VHS path-loader integration** (`src/image-picker.ts`) —
   detects nodes whose `STRING` widget has `vhs_path_extensions`
   (`VHS_LoadImagePath`, `VHS_LoadImagesPath`, `VHS_LoadVideoPath`,
   `VHS_LoadVideoFFmpegPath`). Adds a `📁 Browse` button that opens
   the modal in path-mode, rooted at `folder_paths.base_path`.
   Commits raw absolute paths. Directory loaders get a footer
   "Use this folder" button.

All three surfaces show a **0–5 star rating** on each image card (click a
star to set, click the active star to clear) and a **sort-by-rating**
option. Ratings persist as standard `xmp:Rating` (mirrored to
`MicrosoftPhoto:Rating` for Windows) written **losslessly in-place** into
PNG/JPEG via stdlib byte surgery, or to a `<name>.xmp` sidecar for other
formats — no new Python dependency, no pixel re-encode, ComfyUI's own
workflow chunks preserved. Rating is display-only metadata; it never
changes the committed widget value. See `xmp_meta.py` and ADR-0011.

## File layout

| Path | Purpose |
|------|---------|
| `__init__.py` | Loader stub. Exports `NODE_CLASS_MAPPINGS`, `NODE_DISPLAY_NAME_MAPPINGS`, `WEB_DIRECTORY="./web/dist"`. |
| `gallery_loader.py` | `GalleryLoadImage` node + six HTTP endpoints (`/gallery_loader/{list,base,thumb,file,rating,metadata}`). `/list` takes **`recursive=1`** (sandboxed roots only) for the flat view: every descendant, `dirs:[]`, each file tagged with a forward-slashed `subpath`. Both listing paths are capped and report `truncated`. |
| `image_meta.py` | **Vendored verbatim** from its canonical home `comfyui-image-browser/image_meta.py` — do not edit here. Re-sync with `just sync-image-meta`; CI fails on drift. Pure-stdlib reader behind `/metadata`. The direction is the REVERSE of `xmp_meta.py` / `thumb_cache.py`, which this pack is canonical for: that pack owns the `/metadata` feature and the parser's attacker-shaped-input suite. Each file still has exactly one home. |
| `xmp_meta.py` | Pure, stdlib-only XMP star-rating read/write (in-file PNG/JPEG surgery + `.xmp` sidecar fallback). No ComfyUI imports. See ADR-0011. |
| `src/index.ts` | Lone `bun build` entry. Imports both extension modules for their `app.registerExtension` side-effects. |
| `src/gallery_loader.ts` | Inline-grid frontend for the `GalleryLoadImage` node (TS port of the former `web/js/gallery_loader.js`). |
| `src/image-picker.ts` | Modal picker for stock `LoadImage` + VHS path loaders (TS port; consumes `@laurigates/comfy-modal-kit`). |
| `src/comfyui-shims.d.ts` | Types the `/scripts/app.js` runtime import via the `tsconfig.json` `paths` shim. |
| `web/css/gallery_loader.css` | Inline-grid styles, copied into `web/dist/css/` by the build. (The modal injects its own `<style>` from `image-picker.ts`.) |
| `web/dist/` | **Generated** build output (`bun run build`). Git-ignored; force-shipped to the registry via `[tool.comfy] includes`. |
| `tsconfig.json` | TypeScript config: strict, `noEmit` (bun emits), `/scripts/app.js` `paths` shim. |
| `knip.json` | Dead-export / unused-dependency checker config. |
| `package.json` | Bun scripts (`build`, `typecheck`, `test`, `lint`, `knip`); runtime dep `@laurigates/comfy-modal-kit`; dev deps. |
| `pyproject.toml` | Comfy Registry metadata + `[tool.comfy] includes = ["web/dist"]`. `PublisherId` and `version` are the fields you'd touch. |
| `.github/workflows/publish.yml` | Auto-publish on `pyproject.toml` version bump (runs `bun run build` first). |
| `.github/workflows/ci.yml` | CI: ruff, biome, tsc+build (bun), pytest, vitest (bun), gitleaks. |
| `.pre-commit-config.yaml` | Pre-commit hooks: ruff, biome (2.4.15), gitleaks, file hygiene. |
| `biome.json` | Biome (TS/JSON) lint + format config. |
| `tests/` | pytest suite for the Python backend + Vitest suite (`tests/js/`) for the kit's pure helpers. |
| `screenshots/` | Containerized Playwright pipeline that regenerates `docs/picker.png` + `docs/gallery.png` (`capture.mjs`, `seed_images.py`, `Dockerfile`, `entrypoint.sh`, `workflow.json`). |
| `justfile` | `lint`, `test`, `format`, `check`, `screenshots` recipes. |
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

### The lazy-thumb observer root differs between the two surfaces

`installLazyThumbs`'s `IntersectionObserver` must be rooted on **whatever
element actually scrolls**, and that element is *not* the same in both
frontends:

| Surface | Grid | Scroller | Correct `root` |
|---|---|---|---|
| `gallery_loader.ts` (inline node grid) | `.gl-grid` | `.gl-grid` (`overflow-y: auto`) | the grid |
| `image-picker.ts` (modal) | `.ip-grid` (no overflow clip) | `modal.bodyEl` / `.cmp-body` | **the modal body** |

Rooting on an element with no overflow clip makes the root rectangle that
element's *whole bounding box*, so every card reports as intersecting on the
first callback and the "lazy" load fires for the entire listing at once — one
`/thumb` request per file plus a `src` + `preload=metadata` on every `<video>`.
Measured 400/400 off-screen cards intersecting with the grid as root vs 20/400
with the real scroller; at scale it OOMs the tab. There is a regression test
(`tests/js/image-picker.test.js`) asserting the picker's root. If you move
either grid into or out of a scrolling container, move its `root` with it.

### Listing caps and the extensions clamp

Both `/list` paths are capped and report `truncated`. The cap is applied **after**
an mtime sort, never during the walk — truncating in directory order silently
omits the newest render, which is the one thing the flat view exists to surface.
There is a test that fails against a during-walk cap.

`extensions` is clamped to `IMG_EXTS|VIDEO_EXTS` **in the handler**, not inside
`_parse_extensions`. That helper falls back to `IMG_EXTS` on an empty result, so
moving the clamp into it would re-expand an empty intersection and break
directory mode's `.__none__` sentinel into listing every image. There is a test
named for that trap; the "cleaner" refactor is the wrong one.

### Flat view: never address a file by bare name

In flat view two subfolders can each hold a `ComfyUI_00001_.png`, so a bare
filename is not an identity. Cards carry `data-idx` into the rendered listing and
handlers resolve the file OBJECT; every per-file address (thumbnail, rating,
committed value, metadata, subpath-label target) goes through `fileSub()`, which
joins the file's own `subpath` onto `state.subfolder`. `dataset.name` is
display/debug only. Reverting either handler to a name lookup fails two tests.

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
bun install                  # install TS toolchain + @laurigates/comfy-modal-kit
pre-commit install
```

### Build the frontend

The served frontend is `web/dist/index.js`, emitted from `src/` by bun.
`web/dist/` is git-ignored — build it after a fresh checkout and after any
`src/` change before hard-refreshing ComfyUI.

```sh
bun run build                # bun build src/index.ts → web/dist/ (+ copies web/css)
```

### Lint, typecheck, format

```sh
uv run ruff check .
uv run ruff format .
bunx biome check .
bunx biome check --write .
bun run typecheck            # tsc --noEmit against the frontend types
bun run knip                 # dead-export / unused-dependency check
```

### Tests

```sh
uv run pytest -v             # full backend suite
bun run test                 # JS pure-helper suite (Vitest)
just test                    # both, the local CI gate
```

### JavaScript tests

The Vitest harness covers the pure helpers `fuzzyScore` / `fuzzyRank`,
now imported from `@laurigates/comfy-modal-kit` (the kit replaced the
former vendored `modal-fuzzy.js` / `modal-shell.js`). DOM-dependent code
in `src/image-picker.ts` and `src/gallery_loader.ts` is **not**
unit-tested — it's covered by the smoke matrix below. See
`docs/trps/regression-gaps-initial-scaffold.md` for the rationale and the
trigger conditions for promoting DOM coverage.

Test files live under `tests/js/` and follow `*.test.js`. The
`tests/js/__mocks__/app.js` stub is wired through `vitest.config.js`
(aliased on the `/scripts/app.js` specifier) so future picker-module
tests can import the ComfyUI `app` without a real frontend. The
fuzzy-matcher tests don't need that hook today.

```sh
bun run test                 # one-shot run (CI mode)
bun run test:watch           # watch mode for TDD
```

Note: `package.json`, `node_modules/`, and `src/` are **dev/source-time**.
Only the built `web/dist/` is served to ComfyUI; the kit is inlined into
the bundle (nothing under `node_modules/` is served).

### Iterating on JS / CSS

Changes under `src/` (or `web/css/`) require a **`bun run build`** to
refresh `web/dist/`, then a browser hard-refresh
(Ctrl+Shift+R / Cmd+Shift+R) — **no ComfyUI restart**. Changes to
`gallery_loader.py` (backend node, endpoints) **do** require a restart:

```sh
sudo -n systemctl restart comfyui.service
```

### Endpoint reachability check

```sh
curl -s -o /dev/null -w "%{http_code}\n" \
  http://127.0.0.1:8188/extensions/comfyui-gallery-loader/index.js
# Expected: 200

curl -s http://127.0.0.1:8188/gallery_loader/base | jq .
# Expected: { ok: true, base_path: "...", input_dir: "...", ... }
```

### Screenshots

The README's two PNGs are regenerated by a containerized Playwright
pipeline under `screenshots/`:

```sh
just screenshots
```

This builds a Docker image (pinned ComfyUI + CPU torch + Playwright/
Chromium) and runs it, dropping `docs/picker.png` and `docs/gallery.png`
at `docs/` root. First build ~4 min; cached rebuild ~30 s. The grid
renders real files, so `seed_images.py` paints sample images into
`input/`/`output/`/`temp/` at build time.

**Don't hand-edit `docs/picker.png` / `docs/gallery.png`.** Edit
`screenshots/capture.mjs`, `screenshots/workflow.json`, or
`screenshots/seed_images.py` and regenerate. The Dockerfile COPY target
`custom_nodes/comfyui-gallery-loader` is the served URL prefix — don't
rename it. No CI auto-regeneration; PNGs are committed and refreshed
manually on the same host. See `screenshots/README.md` for pins and
troubleshooting.

### Smoke matrix when changing the picker

After non-trivial frontend changes, verify in browser:

| Node | Expected |
|---|---|
| `LoadImage` | Tabs (Input/Output/Temp); selecting from Output commits `foo.png [output]`. |
| `GalleryLoadImage` | Inline grid renders on the node; switching source chips still works. Sort choice persists and matches the modal's (shared `:sort` key, same ten options). |
| `VHS_LoadImagePath` | 📁 button opens path-mode modal at base dir; selecting a file commits absolute path. |
| `VHS_LoadImagesPath` | 📁 button opens modal in directory mode; footer "Use this folder" commits the absolute dir. |
| `VHS_LoadVideoPath` | Same as image path, with video poster thumbs. |
| Flat view (`≣`) | On a sandboxed tab, folds the current folder's subtree into one newest-first grid; each card labelled with its subpath. Tapping a label drops to folder view there. Picking a nested file commits `sub/dir/foo.png [output]`. Hidden on the path tab and in directory mode. Preference persists; a huge tree toasts "truncated". |
| Flat view — same-named files | Two subfolders each holding `ComfyUI_00001_.png`: clicking each card commits ITS OWN path, and starring one rates only that one. |
| Metadata (`ⓘ`) | On an image card (including on a path picker) → in-dialog overlay, painted immediately with "Reading metadata…", then a source line, one row per recognised field with its own Copy, Copy all, and a collapsed raw disclosure. No `ⓘ` on video cards. A read failure closes the overlay FIRST, then toasts. |
| Pins (`📌`) | Pins the current folder; chips render on their own toolbar row — tap to navigate, ✕ to unpin. Persist across reloads. Hidden on a path picker. |

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
