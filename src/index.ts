// comfyui-gallery-loader — single bun-build entry.
//
// The pack ships two independent ComfyUI frontend extensions, each of which
// registers itself as a module side-effect (`app.registerExtension`):
//
//   - gallery_loader.ts  — inline card-grid for the GalleryLoadImage node.
//   - image-picker.ts    — modal picker over stock LoadImage + VHS path nodes.
//
// Importing both here makes `src/index.ts` the lone bun-build entry that pulls
// in the whole frontend. `bun build` emits `web/dist/index.js`, which
// `__init__.py`'s `WEB_DIRECTORY = "./web/dist"` serves at
// `/extensions/comfyui-gallery-loader/index.js`. See ADR-0010.
import "./gallery_loader.js";
import "./image-picker.js";

// Test seam for the BROWSER suite (tests/e2e), which drives the SERVED bundle at
// its real extension URL rather than importing `src/`. The picker is opened from
// a widget, so there is no app-chrome entry point to reach it through; without
// this export the built module has no exports at all and the fixture cannot open
// anything. Nothing in ComfyUI calls it — the widget hooks above are the
// production path.
export { openImagePicker } from "./image-picker.js";
