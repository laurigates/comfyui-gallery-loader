---
paths:
  - "web/js/**/*.js"
  - "web/**/*.css"
---

# JavaScript Code Style

Patterns for the multi-file JS implementation in `web/js/`.


## Rule

JavaScript logic is split across four files in `web/js/`, each with a
distinct responsibility. No bundler, no transpilation, no `node_modules`
at runtime. Files use native ES modules and import each other directly:

| File | Role | Imports |
|------|------|---------|
| `gallery_loader.js` | Inline-grid for `GalleryLoadImage` node | ComfyUI `app.js` |
| `image-picker.js` | Modal for stock `LoadImage` + VHS path nodes | `app.js`, `modal-shell.js`, `modal-fuzzy.js` |
| `modal-shell.js` | Reusable modal dialog primitive | none |
| `modal-fuzzy.js` | fzf-lite fuzzy matcher (pure helpers) | none |

`modal-shell.js` and `modal-fuzzy.js` are deliberately self-contained
and could be extracted into a shared frontend pack (see ADR / comment
at `modal-fuzzy.js:10`).


## Naming Conventions

| Kind | Convention | Example |
|------|-----------|---------|
| Module-level constants | `UPPER_SNAKE_CASE` | `EXT_NAME`, `DIALOG_ID` |
| Functions | `camelCase` | `openPicker()`, `buildCardEl()`, `enhanceNode()` |
| Widget-patch guard flags | `_galleryLoader<PurposePascalCase>` | `_galleryLoaderPatched`, `_galleryLoaderPointerPatched` |
| CSS class prefix | `cmp-` for modal-shell, `gl-` for gallery-specific | `.cmp-row`, `.gl-card`, `.cmp-match` |


## Do

```js
// Module-level constants — uppercase
const EXT_NAME = "comfyui-gallery-loader";

// Import reusable modules with relative paths
import { openModal } from "./modal-shell.js";
import { fuzzyRank } from "./modal-fuzzy.js";

// Guard flags on widget objects to prevent double-patching
if (!w._galleryLoaderPatched) {
  w._galleryLoaderPatched = true;
  // patch logic...
}

// Optional chaining throughout — never assume properties exist
const graph = app?.graph;
if (!graph?._nodes) return;
```


## Don't

```js
// Don't use bundler-style imports or npm packages at runtime
import _ from "lodash";                  // no — no node_modules served
import { ref } from "vue";               // no — don't import from comfyui_frontend_package

// Don't use var
var picker = {};                          // no — use const/let

// Don't reach across modules other than the documented ones —
// keep modal-shell and modal-fuzzy free of picker-specific concerns
// so they remain extractable.
```


## CSS Embedded in JS

Each module that needs styling injects its own `<style>` tag at first
use, scoped under a stable ID. `modal-shell.js` injects modal CSS;
`gallery_loader.js` uses `web/css/gallery_loader.css` for inline-grid
styles. The split keeps the modal CSS portable when the shell is
extracted.


## File Structure Order (per JS module)

1. Imports
2. Module-level constants
3. Mutable module state (if any)
4. Functions, grouped by responsibility with `// ===...===` dividers
   when the file is long
5. Default export / `app.registerExtension` call at the bottom
   (for entry-point files only)
