---
paths:
  - "pyproject.toml"
  - "*.toml"
  - "*.json"
  - ".github/workflows/*.yml"
---

# Dependencies and Distribution

Package metadata, dependency policy, and Comfy Registry publication workflow.


## Rule

This pack uses **ComfyUI-bundled libraries only** on the Python side. The `dependencies` list in `pyproject.toml` must contain only `comfyui-frontend-package>=<version>` — never a Python runtime library that ComfyUI core doesn't already ship. If a feature genuinely requires a non-bundled library, design it as a separate companion pack.


## pyproject.toml Structure

```toml
[project]
name = "comfyui-gallery-loader"
version = "X.Y.Z"                # semver — bump this to trigger auto-publish
requires-python = ">=3.10"

# Frontend hook floor: comfyui-frontend-package>=1.40 (widget.onPointerDown)
dependencies = [
    "comfyui-frontend-package>=1.40",
]

[tool.comfy]
PublisherId = "<registered-id>"   # must be set before first publish
DisplayName = "Gallery Loader"
```


## Versioning Policy

| Change | Version bump |
|--------|-------------|
| Backend fixes (endpoint bug, path resolution) | `patch` |
| New UI features (modal additions, new card mode) | `minor` |
| Breaking endpoint or value-format changes | `major` |

Bumping `version` in `pyproject.toml` and pushing to `main` is the trigger for the CI publish workflow.


## CI/CD Publication

GitHub Actions workflow (`.github/workflows/publish.yml`) uses `Comfy-Org/publish-node-action@v1`. It fires on:
- Push to `main` when `pyproject.toml` is modified
- Manual `workflow_dispatch`

Required secret: `REGISTRY_ACCESS_TOKEN` — a personal access token from [registry.comfy.org](https://registry.comfy.org/).


## Do

```toml
# Correct — single declared dependency, plus implicit ComfyUI-bundled libs
dependencies = [
    "comfyui-frontend-package>=1.40",
]
```

Backend uses ComfyUI-bundled libraries only: `aiohttp`, `numpy`, `torch`,
`PIL`, plus `folder_paths` / `node_helpers` / `server` from ComfyUI core.


## Don't

```toml
# Wrong — no non-bundled Python runtime libraries
dependencies = [
    "comfyui-frontend-package>=1.40",
    "requests>=2.0",       # no — ComfyUI doesn't ship requests
    "pydantic",            # no — not bundled
    "httpx",               # no — not bundled
]
```

```js
// Wrong — no npm/node_modules at runtime
import fuzzy from 'fuzzysort';   // no — modal-fuzzy.js implements scoring inline
```

The `package.json` and `node_modules/` are **dev-only** for the Vitest
harness. Nothing under `node_modules/` is served to ComfyUI.
