# Release Checklist — comfyui-gallery-loader

Mirrors the comfyui-sampler-info workflow. Auto-publish is wired
through `.github/workflows/publish.yml`; bumping `version` in
`pyproject.toml` on `main` triggers it.

## One-time setup (do once per machine / per repo)

1. **Create the GitHub repo.**

   ```sh
   gh repo create laurigates/comfyui-gallery-loader \
     --public \
     --source=. \
     --description "Touch-friendly gallery picker for ComfyUI image and path widgets" \
     --remote=origin
   ```

2. **Register a publisher on the Comfy Registry.**

   - Sign in at <https://registry.comfy.org/> with the same GitHub
     account that owns this repo.
   - Create a publisher with id `laurigates` (must match
     `pyproject.toml`'s `[tool.comfy] PublisherId`).

3. **Issue a personal access token.**

   - In the registry, generate a token scoped to publish.
   - Add it as a repo secret named `REGISTRY_ACCESS_TOKEN`:

     ```sh
     gh secret set REGISTRY_ACCESS_TOKEN --body "<token>"
     ```

4. **Local dev environment.**

   ```sh
   uv sync --group dev
   npm install --no-audit --no-fund   # only if you'll touch JS tests later
   pre-commit install
   ```

## Per-release

1. **Make sure the workflow you want to ship runs locally.**

   ```sh
   just check        # ruff + biome + pytest
   ```

2. **Bump version in `pyproject.toml`.**

   | Change                                          | Bump  |
   |-------------------------------------------------|-------|
   | Backend fix, picker bug fix, doc fix            | patch |
   | New UI feature, new VHS node support, new tab   | minor |
   | Breaking endpoint or value-format change        | major |

3. **Commit on a feature branch, open a PR.**

   ```sh
   git switch -c release/X.Y.Z
   git add pyproject.toml CHANGELOG.md
   git commit -m "chore: release X.Y.Z"
   git push -u origin release/X.Y.Z
   gh pr create --fill
   ```

4. **Merge to main.** The publish workflow fires automatically (it's
   gated on `paths: pyproject.toml` and `branches: main`). Watch:

   ```sh
   gh run watch
   ```

5. **Verify the release on the registry.**

   - Visit <https://registry.comfy.org/nodes/comfyui-gallery-loader>.
   - The new version should appear within a minute or two.

## Manual publish (rarely needed)

If the workflow needs to run outside the normal trigger (re-publish
without a version bump, retry after a transient failure):

```sh
gh workflow run "Publish to Comfy Registry"
```

## Notes

- The version is the **single source of truth** for the publish
  workflow. CHANGELOG entries are optional but recommended.
- `Comfy-Org/publish-node-action@v1` validates the `[tool.comfy]`
  block — `PublisherId` and `DisplayName` must be present.
- The Comfy Registry expects the pack dir name (`comfyui-gallery-loader`)
  to match the repo name and the pyproject `name`. Don't rename
  any of them in isolation.
