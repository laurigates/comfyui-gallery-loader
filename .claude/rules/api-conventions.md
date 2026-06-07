---
paths:
  - "web/js/**/*.js"
  - "gallery_loader.py"
---

# ComfyUI API Conventions

How this extension wires into the ComfyUI frontend + backend, plus the
HTTP-endpoint contract and value-format contract that ship to users.


## Extension Registration

```js
app.registerExtension({
  name: "comfy.gallery-loader",          // namespaced: "comfy.<pack-name>"
  async setup() { ... },
  async nodeCreated(node) { enhanceNode(node); },
  async loadedGraphNode(node) { enhanceNode(node); },
});
```

Always handle `nodeCreated` and `loadedGraphNode` so the extension
applies to existing graph nodes on load as well as freshly created
ones.


## Widget Detection

The modal targets stock `LoadImage` widgets and VHS path widgets by
inspecting widget shape, not node type. This makes the integration
generic across ComfyUI version skews.

```js
// Do — detect by widget name + options
const LOAD_IMAGE_WIDGETS = new Set(["image"]);
function isLoadImageWidget(w) {
  return LOAD_IMAGE_WIDGETS.has(w.name) && Array.isArray(w.options?.values);
}

function isVhsPathWidget(w) {
  // VHS exposes vhs_path_extensions on its STRING widget
  return Array.isArray(w.options?.vhs_path_extensions);
}

// Don't — node-type-based detection
if (node.type === "LoadImage") { ... }   // too narrow; misses LoadImageOutput, LoadImageMask
```


## Frontend Hook Strategy: A + B Safety Net

The modal opens via two strategies, with B as the version-skew safety
net:

| Strategy | Mechanism | Stability |
|---|---|---|
| **A** | `widget.onPointerDown` patch | Requires `comfyui-frontend-package >= 1.40` |
| **B** | Explicit `📁 Browse` button widget | Always works |

If Strategy A breaks (e.g. frontend renames the hook), Strategy B keeps
the pack functional. **Never remove the explicit button widget.** It's
the reason this pack survives frontend churn.


## Widget Patching Pattern

Wrap existing widget callbacks rather than replacing them. Always chain
to the original:

```js
const origDown = w.onPointerDown;
w.onPointerDown = function (pointer, ownerNode, canvas) {
  if (typeof origDown === "function") {
    const consumed = origDown.call(this, pointer, ownerNode, canvas);
    if (consumed) return consumed;
  }
  openPicker(w, ownerNode || node);
  return true;   // consume — prevents native dropdown
};
```


## Touch-Friendly Modal Dismiss

When opening a full-viewport overlay from a touch-originated
`onPointerDown`, wire backdrop dismiss to **`pointerdown`**, not
`click`. The synthesized `click` event that follows `touchend`
(~300 ms later on iOS Safari) lands on the topmost element under the
original tap coordinates — which is the just-mounted backdrop — and
would immediately re-close the overlay.

```js
// Do — pointerdown is not re-synthesized after touchend
backdrop.addEventListener("pointerdown", dismissPicker);

// Don't — synthesized click after the opening tap dismisses immediately
backdrop.addEventListener("click", dismissPicker);   // BUG on touch
```

Also set `touch-action: manipulation` on backdrop and dialog to
suppress iOS double-tap zoom inside the modal:

```css
#cmp-backdrop, #cmp-dialog {
  touch-action: manipulation;
}
```


## HTTP Endpoint Surface

Five endpoints under `/gallery_loader/`:

| Endpoint | Method | Purpose |
|---|---|---|
| `/list` | GET | Directory listing for picker (`type=input/output/temp/path`); each file carries a `rating` (0–5) |
| `/base` | GET | ComfyUI well-known dirs (base_path, input_dir, output_dir, ...) |
| `/thumb` | GET | Thumbnail for arbitrary-absolute-path images |
| `/file` | GET | Stream arbitrary-absolute-path file (image or video preview) |
| `/rating` | POST | Persist a 0–5 star rating into a file's XMP (or `.xmp` sidecar). Body `{type, subfolder\|path, name, rating}`; same extension-whitelist + traversal gate as `/thumb`/`/file` |

The frontend keeps **no hard-coded paths**. It calls `/base` once,
then drives the picker from there.


## Extension Whitelist — Security Perimeter

`/thumb` and `/file` accept an absolute `path` query parameter. Both
enforce an extension whitelist before reading from disk:

```python
IMG_EXTS = {".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp", ".tiff", ".tif", ".avif"}
VIDEO_EXTS = {".mp4", ".webm", ".mov", ".mkv", ".avi", ".m4v", ".mpg", ".mpeg"}
STREAMABLE_EXTS = IMG_EXTS | VIDEO_EXTS
```

When adding a new file type, **widen the whitelist explicitly** — never
read arbitrary paths without the extension gate. The whitelist is what
prevents arbitrary-file-read by URL crafting.


## Value Contract — Don't Churn Workflows

When the picker commits a value, the format depends on the source. This
contract is **stable** — existing workflows depend on it.

| Source | Committed value | Resolved by |
|---|---|---|
| Input (stock `LoadImage`) | `subdir/foo.png` (bare relative) | core `LoadImage` |
| Output | `subdir/foo.png [output]` | `folder_paths.get_annotated_filepath` |
| Temp | `subdir/foo.png [temp]` | `folder_paths.get_annotated_filepath` |
| VHS path | `/abs/path/foo.png` | VHS path widget (raw absolute) |

**Do not** switch the Input source to annotated form
(`foo.png [input]`) — workflows serialize bare relative paths and
would churn on save/reload. Even though the resolver would accept
annotated form, the format change breaks workflow diffs.


## Corpus / Listing Fetch Pattern

The picker fetches listings via the known extension URL path, never
hard-coded:

```js
const EXT_NAME = "comfyui-gallery-loader";

// Always use { cache: "no-cache" } during dev
fetch(`/gallery_loader/list?type=input&subfolder=`, { cache: "no-cache" })
```

`EXT_NAME` must match the directory name of the pack as installed in
ComfyUI's `custom_nodes/`. If the directory name ever changes, update
`EXT_NAME` — but renaming the pack directory will also break the
`/extensions/<name>/` URL prefix, so don't do it.
