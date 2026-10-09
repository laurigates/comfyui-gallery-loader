default:
    @just --list

# Lint Python with ruff (read-only)
lint-py:
    uv run ruff check .
    # CI runs BOTH (`ruff check` and `ruff format --check`); running only the
    # first here is how a formatting-only failure reaches a PR green locally.
    uv run ruff format --check .

# Lint JavaScript with biome (read-only)
lint-js:
    npx --yes @biomejs/biome check .

# Lint both
lint: lint-py lint-js

# Fix Python (ruff --fix + format)
fix-py:
    uv run ruff check --fix .
    uv run ruff format .

# Fix JavaScript (biome check --write)
fix-js:
    npx --yes @biomejs/biome check --write .

# Fix both
fix: fix-py fix-js

# Run pytest
test-py:
    uv run pytest -v

# Run vitest
test-js:
    npm test

# Run both Python and JavaScript tests
test: test-py test-js

# Run the browser suite (Playwright/Chromium, tests/e2e/).
#
# Builds first: the fixture serves web/dist/index.js at its real extension URL,
# so a stale bundle would test the previous commit. This is the only tier that
# can see scroll clamping, the detached-element read, or the restore loop —
# jsdom performs no layout.
test-e2e:
    bun run build
    bun run test:e2e

# All quality gates (matches CI)
check: lint test test-e2e

# Reachability probe — only meaningful when ComfyUI is running locally
probe:
    @curl -s -o /dev/null -w "extension: %{http_code}\n" http://127.0.0.1:8188/extensions/comfyui-gallery-loader/js/image-picker.js
    @curl -s -o /dev/null -w "base:      %{http_code}\n" http://127.0.0.1:8188/gallery_loader/base

############
# Vendored
############

# image_meta.py is vendored verbatim from comfyui-image-browser at the commit in
# scripts/vendored-pin. That pack owns the /metadata feature and its
# attacker-shaped parser test suite, so the direction is deliberately the
# reverse of xmp_meta.py / thumb_cache.py / pins_store.py, which this pack is
# canonical for. Each file still has exactly one home.
#
# The check diffs against the PINNED commit, never against canonical main, so a
# canonical merge cannot turn an unrelated PR here red (#92). The scheduled
# "Vendored sync" workflow opens the PR that moves the pin; to move it by hand,
# run `just bump-vendored`. Logic lives in scripts/vendored.sh.

# Move the pin to a canonical ref (default: main) and re-fetch every vendored file.
[group: "vendored"]
bump-vendored ref="main":
    scripts/vendored.sh bump {{ref}}

# Restore the vendored image_meta.py from the pinned canonical commit.
[group: "vendored"]
sync-image-meta:
    scripts/vendored.sh sync image_meta.py

# Fail if the vendored image_meta.py differs from the pinned canonical commit.
[group: "vendored"]
check-image-meta-drift:
    @scripts/vendored.sh check image_meta.py

# safeview_store.py, Safe View's prompt-tier cache, is vendored the same way and
# the same direction: it is a thin cache in front of image_meta.py, so it lives
# where that does.

# Restore the vendored safeview_store.py from the pinned canonical commit.
[group: "vendored"]
sync-safeview-store:
    scripts/vendored.sh sync safeview_store.py

# Fail if the vendored safeview_store.py differs from the pinned canonical commit.
[group: "vendored"]
check-safeview-store-drift:
    @scripts/vendored.sh check safeview_store.py

##########
# Assets
##########

# Requires rsvg-convert (librsvg): `brew install librsvg` / `apt-get install librsvg2-bin`.
# pyproject [tool.comfy] Icon/Banner point at the raw GitHub PNG URLs, so the
# registry shows a broken image until you rasterize and commit the PNGs.
#
# Rasterize icon.svg + banner.svg to the PNGs the registry serves (commit them).
[group: "assets"]
assets:
    # Placeholder gate: the scaffold ships a letter-initial glyph so the SVGs are
    # valid from commit one, but no pack may PUBLISH it — pyproject already points
    # Icon/Banner at the PNGs this recipe writes, so a forgotten placeholder ships
    # a generic letter tile to registry.comfy.org (nearly happened on
    # comfyui-output-swap). Draw the bespoke pictogram, delete the marker comment.
    grep -q 'PLACEHOLDER-GLYPH' icon.svg banner.svg && { echo "icon.svg/banner.svg still carry the PLACEHOLDER-GLYPH marker — replace the letter glyph with a bespoke pictogram (family spec: #ffb02e line-art on the dark tile) and delete the marker comment before rasterizing."; exit 1; } || true
    rsvg-convert -w 400 -h 400 icon.svg -o icon.png
    rsvg-convert -w 1344 -h 576 banner.svg -o banner.png
    # Consistency gate: the family tile must trim to 346x346+27+27 on a 400x400
    # canvas. A mismatch means the icon drifted off the family spec (wrong
    # canvas size or a full-bleed tile) — see comfy-registry-lifecycle. Skipped
    # when ImageMagick's `identify` is absent (rsvg-convert is the only hard dep).
    command -v identify >/dev/null 2>&1 && { test "$(identify -format '%wx%h/%@' icon.png)" = "400x400/346x346+27+27" || { echo "icon.png off family spec (want 400x400/346x346+27+27)"; exit 1; }; } || true

##########
# Documentation artifacts
##########

# Regenerate docs/picker.png and docs/gallery.png via the screenshot generator.
[group: "docs"]
screenshots:
    docker build -f screenshots/Dockerfile -t comfyui-gallery-loader-screenshots .
    docker run --rm -v "$(pwd)/docs:/out" comfyui-gallery-loader-screenshots
