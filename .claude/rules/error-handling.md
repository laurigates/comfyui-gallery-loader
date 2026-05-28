---
paths:
  - "web/js/**/*.js"
  - "gallery_loader.py"
---

# Error Handling

Patterns for graceful degradation in the ComfyUI frontend + thin-backend
context — where failures must not crash the host application.


## Rule

All potentially-failing operations in the frontend are wrapped in
try/catch with `console.warn` prefixed by the extension name. Functions
use early-return null guards rather than nested conditionals. Optional
chaining (`?.`) is used throughout for DOM and API property access.

On the backend, HTTP endpoints return structured JSON errors with
appropriate status codes — they do not raise into the aiohttp dispatch
layer.


## Examples


### Frontend — Do

```js
// Prefix all warnings with the extension name so they're filterable in devtools
function safeFetch(url) {
  return fetch(url, { cache: "no-cache" })
    .then((r) => r.json())
    .catch((e) => {
      console.warn(`[comfyui-gallery-loader] fetch failed: ${url}`, e);
      return null;
    });
}

// Early return null guards — keep the happy path unindented
function findWidget(node, names) {
  if (!node?.widgets) return null;
  for (const w of node.widgets) {
    if (names.has(w.name)) return w;
  }
  return null;
}

// Guard flag prevents double-patching in case enhanceNode is called twice
if (!w._galleryLoaderPatched) {
  w._galleryLoaderPatched = true;
  // patch...
}

// Wrap extension logic inside existing callbacks so errors don't break the original
const origDown = w.onPointerDown;
w.onPointerDown = function (pointer, ownerNode, canvas) {
  try {
    if (typeof origDown === "function") {
      const consumed = origDown.call(this, pointer, ownerNode, canvas);
      if (consumed) return consumed;
    }
    openPicker(w, ownerNode || node);
    return true;
  } catch (e) {
    console.warn(`[comfyui-gallery-loader] picker open failed`, e);
    return false;
  }
};
```


### Frontend — Don't

```js
// Don't let errors propagate uncaught — they crash the ComfyUI console with noise
w.callback = function (value) {
  refreshPicker(w); // throws uncaught if endpoint not reachable → bad UX
};

// Don't use console.error for expected / non-fatal degradation
console.error("listing endpoint failed"); // use console.warn instead

// Don't skip the extension-name prefix — makes filtering impossible
console.warn("listing failed", e); // prefer `[comfyui-gallery-loader] listing failed`
```


### Backend — Do

```python
# Structured JSON errors — never raise into aiohttp dispatch
if not folder_paths.get_directory_by_type(type_name):
    return web.json_response({"ok": False, "error": f"unknown type: {type_name}"}, status=400)

# Per-entry try/except so a single broken symlink doesn't abort the listing
with os.scandir(base) as it:
    for entry in it:
        try:
            ...
        except OSError:
            continue

# Top-level except wraps the whole endpoint
try:
    ...
except PermissionError as exc:
    return web.json_response({"ok": False, "error": str(exc)}, status=403)
except OSError as exc:
    return web.json_response({"ok": False, "error": str(exc)}, status=500)
```


### Backend — Don't

```python
# Wrong — bare exception that swallows the cause
try:
    ...
except Exception:
    return web.Response(status=500)

# Wrong — letting OSError propagate to the aiohttp dispatcher
files = [entry for entry in os.scandir(base)]
```


## Additive Degradation

When an endpoint can't service a request, the frontend should leave the
existing UI state alone. Empty results render as empty grids, not error
modals. Network errors log to the console with the extension prefix and
the user can retry by interacting again.
