default:
    @just --list

# Lint Python with ruff (read-only)
lint-py:
    uv run ruff check .

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

# All quality gates (matches CI)
check: lint test

# Reachability probe — only meaningful when ComfyUI is running locally
probe:
    @curl -s -o /dev/null -w "extension: %{http_code}\n" http://127.0.0.1:8188/extensions/comfyui-gallery-loader/js/image-picker.js
    @curl -s -o /dev/null -w "base:      %{http_code}\n" http://127.0.0.1:8188/gallery_loader/base

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
