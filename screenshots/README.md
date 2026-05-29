# Screenshot generator

Containerized Playwright driver that produces the README's two PNGs:

| File | What it shows |
|---|---|
| `docs/picker.png` | The modal picker over a stock `LoadImage` node — Input/Output/Temp tabs + a populated card grid with `width×height` meta |
| `docs/gallery.png` | The inline card grid mounted on the `GalleryLoadImage` node body (`.gl-root`) |

## Regenerating

From the repository root:

```sh
just screenshots
```

That builds `screenshots/Dockerfile` and runs the resulting image with
`-v $(pwd)/docs:/out` so the generated PNGs land in `docs/`. The first
build takes ~4 minutes (downloads CPU torch + Chromium); subsequent
builds rebuild in ~30s when only the capture script or workflow change.

## Sample images

Unlike a static picker, this pack's grid lists **real files** from
ComfyUI's `input/`, `output/`, and `temp/` directories. A fresh ComfyUI
clone has those dirs empty, so the grid would be blank. `seed_images.py`
paints a small corpus of visually distinct, varied-dimension PNGs (a
per-tile gradient + centered label) into those dirs at **build time**.

They are generated, not committed: PIL ships with ComfyUI (Pillow
dependency), the corpus is deterministic (hue derived from index, no
RNG), and keeping binaries out of the repo avoids fixture churn. The
seeding `RUN` is ordered before the pack `COPY` so its layer caches and
re-runs don't regenerate the corpus.

## Pins

| Component | Pin | Notes |
|---|---|---|
| ComfyUI | `COMFYUI_REF=v0.22.0` (Dockerfile `ARG`) | Ships `comfyui-frontend-package==1.43.18`, clearing the pack's `>=1.40` floor (Strategy-A `onPointerDown` hook). The frontend bundle is what's being screenshotted — bumping changes font rendering and is a deliberate act. |
| Playwright | `playwright@1.49.1` (`package.json`) | Playwright bundles a specific Chromium revision; pinning the package pins the browser. Keep in sync with the base-image tag. |
| Chromium flags | `--font-render-hinting=none` | Removes a common source of cross-host rendering drift. |
| Viewport | `1280x800` @ `deviceScaleFactor: 2` | Fixed in `capture.mjs`. |

The first-pass goal is "re-runs without source changes produce byte-
identical PNGs on the same host." Cross-host parity is not guaranteed
— rebuild on the same host that originally produced the committed
PNGs when you regenerate.

## Capture approach

`capture.mjs` loads a two-node workflow (stock `LoadImage` +
`GalleryLoadImage`) once, then captures both shots:

1. **`gallery.png`** — normalizes the canvas (`ds.scale = 1` + an offset
   that parks the node near the top-left), waits for the `.gl-root` DOM
   widget to mount and its grid to populate from the seeded `input/`,
   then takes an **element screenshot of `.gl-root`**. The element shot
   gives a clean grid without canvas chrome, sidestepping the
   canvas-coordinate fragility a full-page shot would hit.
2. **`picker.png`** — opens the modal via `widget.onPointerDown(...)`
   (Strategy A), falling back to the 📁 Browse button widget's callback
   (Strategy B) if the hook doesn't open the dialog on this frontend
   build. Waits for `.cmp-dialog` + a populated `.ip-grid`, then element-
   screenshots the dialog.

Env knobs: `OUT_DIR` (default `/out`), `COMFYUI_URL`
(default `http://127.0.0.1:8188/`), `PICKER_QUERY` (optional — type a
filter into the modal search to show the fuzzy-match state; empty by
default).

## Troubleshooting

### Grid is empty (either shot)

The seeder didn't run, or wrote to the wrong dir. Confirm the listing
endpoint sees the files from inside the container:

```sh
docker run --rm -it --entrypoint bash comfyui-gallery-loader-screenshots
# inside: start ComfyUI, then in another shell / after readiness:
curl -s '127.0.0.1:8188/gallery_loader/list?type=input' | jq '.files | length'
```

If that's `0`, ComfyUI's input dir differs from `/opt/ComfyUI/input` —
re-run `python /opt/screenshots/seed_images.py` with explicit dirs, or
align `COMFY_DIR`.

### `gallery.png` blank or clipped

The DOM-widget overlay is off-viewport or hidden by `hideOnZoom`. The
fix is the `ds.scale = 1` + offset normalization in `captureGallery`
plus the `.gl-root` element screenshot — verify the node type matches
(`GalleryLoadImage`) and the scale didn't drop below the readability
threshold.

### `picker.png` modal never opens

`_galleryPickerEnhanced` was never set on the LoadImage node (frontend
skew — `enhanceLoadImageNode` didn't patch). Inspect in a real browser
and check devtools for `[comfyui-gallery-loader]` warnings:

```sh
docker run --rm -it -p 8188:8188 --entrypoint bash \
    comfyui-gallery-loader-screenshots
# inside the container:
/opt/screenshots/entrypoint.sh   # or: python main.py --cpu --listen 0.0.0.0
```

Then open `http://localhost:8188/`. The capture already falls back to
the 📁 Browse button (Strategy B); if even that fails, the hook surface
changed upstream — update `web/js/image-picker.js` first, then
regenerate.

### "ComfyUI did not become ready" timeout

`entrypoint.sh` tails the last 200 lines of `/tmp/comfyui.log` when the
readiness probe fails. Usually a new ComfyUI release added a runtime
dependency not in `requirements.txt` — bump `COMFYUI_REF` to a tag whose
`requirements.txt` matches what `pip install` pulls.

## Layout

| Path | Purpose |
|---|---|
| `Dockerfile` | ComfyUI + CPU torch + Node 22 + Playwright + Chromium; seeds sample images at build time |
| `entrypoint.sh` | Launches ComfyUI, waits for `/system_stats`, runs `capture.mjs`, asserts both PNGs exist |
| `capture.mjs` | Playwright driver (single-file ESM) — loads workflow, captures inline grid + modal |
| `seed_images.py` | PIL sample-image seeder for `input/`/`output/`/`temp/` |
| `workflow.json` | Two-node workflow (`LoadImage` + `GalleryLoadImage`) at fixed positions |
| `package.json` | Pins `playwright` (the only npm dependency) |
| `.dockerignore` | Keeps the build context lean — excludes `docs/`, `.git/`, `tests/`, etc. |
