---
paths:
  - "tests/**"
  - "web/js/**/*.js"
  - "gallery_loader.py"
  - ".pre-commit-config.yaml"
---

# Testing Requirements

## Pure-Helper Validation

Pure backend helpers and pure frontend helpers carry real unit tests:

| Layer | Location | Framework |
|-------|----------|-----------|
| Python helpers (`_parse_extensions`, `_resolve_input_string`, etc.) | `tests/test_helpers.py` | pytest |
| Python loader stub | `tests/test_init.py` | pytest |
| JS fuzzy matcher (`fuzzyScore`, `fuzzyRank`) | `tests/js/modal-fuzzy.test.js` | Vitest |

DOM-dependent helpers (`highlightMatches`, modal-shell DOM builders) are
currently uncovered — the smoke matrix below substitutes. Promoting
them to unit coverage means adding `jsdom` as a Vitest environment.

## Syntax Validation

Run before every commit:

```sh
# JavaScript syntax check
node --check web/js/gallery_loader.js
node --check web/js/image-picker.js
node --check web/js/modal-shell.js
node --check web/js/modal-fuzzy.js

# Python lint + format
uv run ruff check .
uv run ruff format --check .
```

## Test Runners

```sh
just test-py         # pytest -v on tests/
just test-js         # vitest run on tests/js/
just test            # both
just check           # lint + test (the CI gate)
```

## Live Smoke Matrix

After non-trivial picker changes, verify in browser:

| Node | Expected |
|---|---|
| `LoadImage` | Tabs (Input/Output/Temp); selecting from Output commits `foo.png [output]`. |
| `GalleryLoadImage` | Inline grid renders on the node; switching source chips still works. |
| `VHS_LoadImagePath` | 📁 button opens path-mode modal at base dir; selecting commits absolute path. |
| `VHS_LoadImagesPath` | 📁 button opens modal in directory mode; footer "Use this folder" commits absolute dir. |
| `VHS_LoadVideoPath` | Same as image path, with video poster thumbs. |

Keyboard navigation: Up, Down, PgUp, PgDn, Enter, Esc; type anywhere
to filter; Backspace from anywhere.

## Server Reachability

```sh
curl -s -o /dev/null -w "%{http_code}\n" \
  http://127.0.0.1:8188/extensions/comfyui-gallery-loader/js/image-picker.js
# Expected: 200

curl -s http://127.0.0.1:8188/gallery_loader/base | jq .
# Expected: { ok: true, base_path: "...", input_dir: "...", ... }
```

## Endpoint Whitelist Discipline

When adding a new file type or endpoint:

- Widen `IMG_EXTS` / `VIDEO_EXTS` / `STREAMABLE_EXTS` in
  `gallery_loader.py` **explicitly**.
- Never read arbitrary absolute paths without the extension gate.
- Add a pytest case to `tests/test_helpers.py` covering the new
  extension behaviour.

## Debugging

If the picker stops opening:
1. Check browser devtools console for `comfyui-gallery-loader` warnings.
2. Verify the `onPointerDown` hook still exists in the frontend bundle
   (Strategy A).
3. Confirm the explicit `📁 Browse` button (Strategy B) still works
   on VHS nodes — that path doesn't depend on the hook.
