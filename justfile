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
# Documentation artifacts
##########

# Regenerate docs/picker.png and docs/gallery.png via the screenshot generator.
[group: "docs"]
screenshots:
    docker build -f screenshots/Dockerfile -t comfyui-gallery-loader-screenshots .
    docker run --rm -v "$(pwd)/docs:/out" comfyui-gallery-loader-screenshots
