---
paths:
  - "web/js/**/*.js"
  - "web/css/**/*.css"
  - "__init__.py"
  - "gallery_loader.py"
---

# Development Workflow

## Project Context

`comfyui-gallery-loader` is a ComfyUI custom-node pack with a thin Python
backend (one node + four HTTP endpoints) and a multi-file frontend.

- `__init__.py` is a loader stub. Exports node mappings + `WEB_DIRECTORY`.
- `gallery_loader.py` holds the `GalleryLoadImage` node + the four
  `/gallery_loader/{list,base,thumb,file}` endpoints.
- Frontend JS is split across four files in `web/js/`:
  - `gallery_loader.js` — inline-grid for `GalleryLoadImage`
  - `image-picker.js` — modal over stock `LoadImage` + VHS path nodes
  - `modal-shell.js` — reusable modal dialog (backdrop, toolbar, ESC)
  - `modal-fuzzy.js` — fzf-lite fuzzy matcher

## Core Constraints

- **Pack directory name is part of the URL**: do not rename
  `comfyui-gallery-loader/`. Files in `web/js/` are served at
  `/extensions/comfyui-gallery-loader/js/<name>.js`.
- **No new Python dependencies**: backend uses ComfyUI-bundled libs only.
- **Value contract is stable**: see `api-conventions.md` for the
  per-source committed-value format. Don't churn workflows.
- **Frontend hook is version-sensitive**: modal opens via
  `widget.onPointerDown` (Strategy A) with an explicit `📁 Browse`
  button as fallback (Strategy B). Don't remove the button.

## Commit Conventions

- Use [Conventional Commits](https://www.conventionalcommits.org/):
  `feat:`, `fix:`, `docs:`, `chore:`, `refactor:`, `test:`
- Scope optional but encouraged: `feat(picker):`, `fix(endpoint):`,
  `docs(adr):`
- Keep subject line under 72 characters

## Branch & PR Conventions

- Feature work on `feature/<slug>` branches
- Bug fixes on `fix/<slug>` branches
- Open PRs to `main`; do not push directly to `main`

## Restart vs Hard-Refresh

- Changes under `web/` (JS/CSS): browser hard-refresh
  (Ctrl+Shift+R / Cmd+Shift+R). **No ComfyUI restart needed.**
- Changes to `gallery_loader.py` (backend node, endpoints): restart
  ComfyUI:

  ```sh
  sudo -n systemctl restart comfyui.service
  ```

## Versioning

Semver in `pyproject.toml`:
- **patch** — backend fixes
- **minor** — UI features
- **major** — breaking endpoint or value-format changes
