---
id: ADR-0005
created: 2026-05-28
status: Accepted
domain: deployment
relates-to: [PRD-001, ADR-0001]
---

# Package Management and Distribution via pyproject.toml and Comfy Registry

## Status

Accepted

## Context

ComfyUI packs are distributed through two channels:

1. **Comfy Registry** (`registry.comfy.org`) — the official package index. Metadata lives in `pyproject.toml` under `[project]` and `[tool.comfy]`. Publication is by GitHub Actions running `Comfy-Org/publish-node-action@v1`.
2. **ComfyUI-Manager** (`custom-node-list.json`) — community-maintained list that ComfyUI-Manager surfaces in its installer UI.

The pack also uses `uv` for local Python dev (lockfile, venv, tool invocation) rather than `pip` + `requirements.txt`.

## Decision

Use `pyproject.toml` as the single source of truth for both package metadata and dev dependencies. Use `uv` locally; rely on `astral-sh/setup-uv@v7` in CI.

- `[project]` block — name, version (semver), `requires-python>=3.10`, `dependencies` (only `comfyui-frontend-package>=1.40`).
- `[tool.comfy]` block — `PublisherId`, `DisplayName`. Both required for Registry publication.
- `[dependency-groups.dev]` — pytest, pre-commit. Installed via `uv sync --group dev`.
- `uv.lock` checked in for reproducible CI.

Version bumps drive distribution: pushing to `main` with a modified `pyproject.toml` version triggers `.github/workflows/publish.yml`, which runs the publish-node-action.

## Consequences

- **Positive**: single source of truth for package metadata. No drift between `setup.py`, `requirements.txt`, and `pyproject.toml`.
- **Positive**: `uv` is fast — local install + lock takes seconds.
- **Positive**: CI uses the same lockfile as local dev. No "works on my machine" version drift.
- **Negative**: `PublisherId = "TODO-publisher-id"` is a placeholder until the registry account is created. Until then, the publish workflow fails on missing publisher.
- **Negative**: `uv` is younger than pip. Acceptable — Astral is a stable maintainer and the lockfile format is documented.
