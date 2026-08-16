# CLAUDE.md

ComfyUI custom-node pack with a small Python backend (one node + six
HTTP endpoints) and a TypeScript frontend (`src/`) built to `web/dist/`
via `bun build`. The modal shell + fuzzy matcher come from the shared
`@laurigates/comfy-modal-kit` (inlined into the bundle). Both halves
share a card-grid picker that targets touch-friendly mobile/tablet use
as well as desktop. See ADR-0010 for the TypeScript + bun build decision.

## What it does

Three entry points share one picker UI:

1. **`Load Image (Gallery)` node** (`gallery_loader.py` +
   `src/gallery_loader.ts`) — drop-in `LoadImage` replacement with
   the picker rendered inline on the node body. Cards scroll
   independently of the canvas.
2. **Modal over stock `LoadImage`** (`src/image-picker.ts`) —
   intercepts the `image` combo widget on `LoadImage`,
   `LoadImageMask`, `LoadImageOutput`. Source tabs for **Input /
   Output / Temp**; commits annotated values (`foo.png [output]`)
   that core's `folder_paths.get_annotated_filepath` resolves
   transparently.
3. **Video + folder combo loaders** (`src/image-picker.ts`) — core
   `LoadVideo` (detected by its `video_upload` flag, same defang path
   as `image_upload`) and VHS's upload-flavour `VHS_LoadVideo`,
   `VHS_LoadVideoFFmpeg`, `VHS_LoadImages` (detected by **class name** —
   VHS builds those widgets from its own JS and leaves no marker on the
   input spec). Same sandboxed tabs and annotated values; VHS resolves
   them through `get_annotated_filepath` after its own `strip_path`.
   `VHS_LoadImages` runs in directory mode.
4. **VHS path-loader integration** (`src/image-picker.ts`) —
   detects nodes whose `STRING` widget has `vhs_path_extensions`
   (`VHS_LoadImagePath`, `VHS_LoadImagesPath`, `VHS_LoadVideoPath`,
   `VHS_LoadVideoFFmpegPath`). Adds a `📁 Browse` button that opens
   the modal in path-mode, rooted at `folder_paths.base_path`.
   Commits raw absolute paths. Directory loaders get a footer
   "Use this folder" button.

All three surfaces show a **0–5 star rating** on each image card (click a
star to set, click the active star to clear) and a **sort-by-rating**
option. Ratings persist as standard `xmp:Rating` (mirrored to
`MicrosoftPhoto:Rating` for Windows) written **losslessly in-place** into
PNG/JPEG via stdlib byte surgery, or to a `<name>.xmp` sidecar for other
formats — no new Python dependency, no pixel re-encode, ComfyUI's own
workflow chunks preserved. Rating is display-only metadata; it never
changes the committed widget value. See `xmp_meta.py` and ADR-0011.

## File layout

| Path | Purpose |
|------|---------|
| `__init__.py` | Loader stub. Exports `NODE_CLASS_MAPPINGS`, `NODE_DISPLAY_NAME_MAPPINGS`, `WEB_DIRECTORY="./web/dist"`. |
| `gallery_loader.py` | `GalleryLoadImage` node + eight HTTP endpoints (`/gallery_loader/{list,base,thumb,file,rating,metadata}` plus `GET`/`POST /gallery_loader/pins`). `/list` takes **`recursive=1`** (sandboxed roots only) for the flat view: every descendant, `dirs:[]`, each file tagged with a forward-slashed `subpath`. Both listing paths are capped and report `truncated`. `GET /pins` answers `{ok, max, pins}` with every pin resolved (`exists`, plus a live file pin's `/list` per-file keys); `POST /pins` takes one **delta** — `{op: "add"｜"remove"｜"prune", item?}` — and answers with the same whole list, so a caller never needs a follow-up GET. |
| `pins_store.py` | **Canonical home** of the shared pin store — `comfyui-image-browser` vendors it verbatim (`just sync-pins-store` there + a CI drift job pull from this repo's `main`), so a change here must be synced downstream. Same direction as `xmp_meta.py` / `thumb_cache.py`, the opposite of `image_meta.py`. Pure-stdlib: normalization, the delta dispatcher, and atomic read/write of `<user_dir>/comfy-pins.json` — the one file both packs and both devices resolve. |
| `image_meta.py` | **Vendored verbatim** from its canonical home `comfyui-image-browser/image_meta.py` — do not edit here. Re-sync with `just sync-image-meta`; CI fails on drift. Pure-stdlib reader behind `/metadata`. The direction is the REVERSE of `xmp_meta.py` / `thumb_cache.py`, which this pack is canonical for: that pack owns the `/metadata` feature and the parser's attacker-shaped-input suite. Each file still has exactly one home. |
| `xmp_meta.py` | Pure, stdlib-only XMP read/write (in-file PNG/JPEG surgery + `.xmp` sidecar fallback). No ComfyUI imports. Two owned vocabularies: the `xmp:Rating` star (ADR-0011) and the `dc:subject` keywords Safe View's tag tier matches, each mirrored to its `MicrosoftPhoto:` twin. Both writes go through `_write_xmp` + `update_xmp_packet`; see the hard rule below for why the two halves must never strip each other's. |
| `src/index.ts` | Lone `bun build` entry. Imports both extension modules for their `app.registerExtension` side-effects. |
| `src/gallery_loader.ts` | Inline-grid frontend for the `GalleryLoadImage` node (TS port of the former `web/js/gallery_loader.js`). |
| `src/image-picker.ts` | Modal picker for stock `LoadImage` + VHS path loaders (TS port; consumes `@laurigates/comfy-modal-kit`). |
| `src/safe-tag.ts` | The `🙈` mark-sensitive control, shared by both frontends: which keyword it writes, whether a file already carries it, the `/tag` request body, and the button markup. One module because BOTH surfaces carry the control and two hand-written copies of "which keyword" is exactly what drifts. |
| `src/comfyui-shims.d.ts` | Types the `/scripts/app.js` runtime import via the `tsconfig.json` `paths` shim. |
| `web/css/gallery_loader.css` | Inline-grid styles, copied into `web/dist/css/` by the build. (The modal injects its own `<style>` from `image-picker.ts`.) |
| `web/dist/` | **Generated** build output (`bun run build`) — **tracked in git**, and shipped to the registry via `[tool.comfy] includes`. Tracked deliberately: ComfyUI-Manager updates over git, and a `fetch && merge --ff-only` cannot pull an ignored path, so an ignored bundle updates "successfully" while ComfyUI keeps serving the stale one. Rebuild and commit it in the same commit as any `src/` change. |
| `tsconfig.json` | TypeScript config: strict, `noEmit` (bun emits), `/scripts/app.js` `paths` shim. |
| `knip.json` | Dead-export / unused-dependency checker config. |
| `package.json` | Bun scripts (`build`, `typecheck`, `test`, `lint`, `knip`); runtime dep `@laurigates/comfy-modal-kit`; dev deps. |
| `pyproject.toml` | Comfy Registry metadata + `[tool.comfy] includes = ["web/dist"]`. `PublisherId` and `version` are the fields you'd touch. |
| `.github/workflows/publish.yml` | Auto-publish on `pyproject.toml` version bump (runs `bun run build` first). |
| `.github/workflows/ci.yml` | CI: ruff, biome, tsc+build (bun), pytest, vitest (bun), gitleaks. |
| `.pre-commit-config.yaml` | Pre-commit hooks: ruff, biome (2.4.15), gitleaks, file hygiene. |
| `biome.json` | Biome (TS/JSON) lint + format config. |
| `tests/mutations.json` / `tests/mutations-e2e.json` | Mutation tables driving `just mutation-check comfyui-gallery-loader [tests/mutations-e2e.json]` from the workspace root. Two files because the tiers differ: the first runs vitest+pytest, the second rebuilds the bundle and runs the **browser** suite, because the scroll wiring is not observable anywhere else. Each carries a deliberate **CONTROL** mutation (a comment edit) the suite must MISS — a harness reporting everything as CAUGHT is indistinguishable from a broken one — so a healthy run exits **1**. Read the per-mutation lines, not the exit code. |
| `tests/` | pytest suite for the Python backend + Vitest suite (`tests/js/`) for the kit's pure helpers. **No layout engine** — see `tests/e2e/` for the half of the picker's behaviour this suite structurally cannot see. |
| `tests/conftest.py` | The stub layer that makes endpoint-level pytest possible at all: `web.json_response` → `_stub_json_response`, and `web.Response` / `web.FileResponse` → `_stub_response` / `_stub_file_response`. Without the latter two the non-JSON handlers hand back MagicMocks, so `/thumb`'s ETag/304 logic and `/file`'s whitelist have nothing assertable. `FakeGetRequest` (exposed as the `get_request` fixture) carries `.headers` as well as `.rel_url.query` — the `_FakeGetRequest` in `test_helpers.py` does not, and a conditional-request test written against that one silently takes the unconditional branch. |
| `tests/test_endpoints.py` | `/thumb`, `/file`, `/base` at the handler level — status ladder, extension whitelist, and the conditional-request contract (ETag stable, `If-None-Match` → 304 with no body but WITH the cache headers, ETag moves on mtime **or** size). Every rejection is paired with the acceptance of a file differing only in the thing under test, so none of it passes against a handler wired to refuse everything. |
| `tests/e2e/` | **Browser suite** — Playwright driving real Chromium at a 390×844 phone viewport (`bun run test:e2e`, `just test-e2e`). It exists because the jsdom suite **cannot fail** for anything about scrolling: jsdom performs no layout, so it accepts `scrollTop = 500` on a zero-height scroller and reads it back verbatim — detached or not. A real engine **clamps** the assignment to `scrollHeight - clientHeight` at the instant of the write, and answers **0** from a detached element (the state the kit's teardown leaves the dialog in before `onClose` runs). `server.mjs` is a stdlib-only stub ComfyUI serving the **built** `web/dist/index.js` at its real extension URL plus `/gallery_loader/{base,list,thumb,file,pins}` — real PNG bytes, because a 404 thumb changes the layout under test; listing size is derived from the folder name (`bulk-400` holds 400 files) so the server stays stateless. `fixture.html` opens the picker through the bundle's exported `openImagePicker()` with a stub widget+node. `harness.js` holds the drivers, `probe.js` the `scrollTop`-setter spy that separates "clamped at assignment" from "moved afterwards" (both PORTS of `comfyui-image-browser`'s, which is where they were written). **Navigation goes through `tapWithoutScrolling`**, never Playwright's pointer: Playwright scrolls a target into view first, and folder / `..` cards sit at the TOP of the grid, so at a deep offset the harness moves the scroller to ~0 before `rememberScroll()` runs — measured here on the first run, five tests failing with a remembered 0 against a parked 743. The two gesture tests throttle the renderer (`Emulation.setCPUThrottlingRate`) so the ~200 ms restore window cannot close before an out-of-process CDP keypress arrives; do not replace that with a sleep or a retry, which hides the race instead of removing it. **Chromium-only**: no WebKit exists here, so iOS **momentum scrolling is NOT covered** by any test. |
| `screenshots/` | Containerized Playwright pipeline that regenerates `docs/picker.png` + `docs/gallery.png` (`capture.mjs`, `seed_images.py`, `Dockerfile`, `entrypoint.sh`, `workflow.json`). |
| `justfile` | `lint`, `test`, `format`, `check`, `screenshots` recipes. |
| `RELEASE-CHECKLIST.md` | One-time and per-release publish steps. |

## Hard rules

### No new Python dependencies

The Python backend uses ComfyUI-bundled libraries only (`aiohttp`,
`numpy`, `torch`, `PIL`, plus `folder_paths`/`node_helpers`/`server`
from ComfyUI core). `pyproject.toml` declares only
`comfyui-frontend-package>=1.40` — the frontend hook floor. Don't
add `requests`, `httpx`, `pydantic`, etc. If a feature needs a
non-bundled library, design it as an optional companion pack.

### A metadata write is read-modify-write — never rebuild the packet

`xmp_meta.build_xmp_packet()` returns a packet containing **only** the
properties asked for at that call. Writing it over a file that already has XMP
destroys every other property that file carried — `dc:subject` keywords, the `dc:description`
caption, `dc:creator`, `dc:rights` — and nothing in this pack reads those, so
nothing notices. That was the bug fixed in #97: latent for fresh ComfyUI
renders (no prior XMP), real data loss for anything imported or previously
tagged in digiKam / Lightroom / Bridge / XnView.

Every write path therefore goes through **`_write_xmp()` → `update_xmp_packet()`**,
which parses the existing packet, touches only the properties that write owns —
`xmp:Rating` / `MicrosoftPhoto:Rating` for a star, in either legal
serialisation (attribute *or* child element, on *any* `rdf:Description`) —
and re-serialises everything else under its original prefix. `build_xmp_packet`
is reachable only when there is no existing packet, and a rating-only call
there stays byte-identical to what shipped before.

Two consequences worth keeping straight:

- **A packet we refuse to parse is never overwritten.** Oversize,
  DOCTYPE/ENTITY, unparseable, or not RDF-shaped → `update_xmp_packet` returns
  None and the write goes to the sidecar — for a keyword write exactly as for
  a rating. That is safe precisely because the *same* gate stops `read_meta`
  from reading the in-file packet, so the sidecar is not shadowed. If you ever
  relax one gate, relax both.
- **ElementTree is not the serialiser.** `ET.tostring` re-invents every prefix
  as `ns0:`/`ns1:`, and the fix for that (`ET.register_namespace`) mutates a
  process-global map shared with everything else in ComfyUI. The module
  collects the document's own prefix declarations and writes the XML itself.
  Don't swap it back for `ET.tostring`.

### …and the two owned vocabularies never strip each other

`xmp_meta` owns two things, and they have different *shapes*. `xmp:Rating` is
scalar: legal as an attribute or a child element, replaced wholesale, stripped
in both forms before the new value is set. `dc:subject` is an `rdf:Bag` of
`rdf:li` — it cannot be an attribute, and it is where the file's OTHER keywords
live. `OWNED_PROPERTIES` is therefore split into `OWNED_SCALAR_PROPERTIES` and
`OWNED_BAG_PROPERTIES`, and **each write strips only its own half**. Stripping
the union would make a star click delete every keyword on the file — #97 wearing
a different hat, and just as invisible.

Three consequences, each pinned by a mutation:

- **A keyword write is a DELTA** (`add_tags` / `remove_tags`), merged against
  the packet inside the write. It cannot be "here is the new list": the caller
  cannot pre-read the list, because *which* packet gets written (in-file or
  sidecar) is decided inside `_write_xmp`. It edits `rdf:li` elements in place
  rather than re-emitting them, which is also what keeps an `xml:lang`
  qualifier on a keyword alive.
- **Read whichever container is there.** `rdf:Seq`, `rdf:Alt`, the bare
  `<dc:subject>x</dc:subject>` simple value and the (illegal but real)
  attribute form all occur in the wild. Assuming `rdf:Bag` reads *nothing* off
  those files, which is indistinguishable from "untagged".
- **`parse_meta_from_xmp` parses once** and both single-property readers
  delegate to it. Reading rating and keywords through two `ET.fromstring` calls
  measured +40% on the metadata pass over a 2000-file directory, for nothing.

`tests/mutations.json` pins all of this — `just mutation-check
comfyui-gallery-loader` from the workspace root. There is a SECOND table,
`tests/mutations-e2e.json`, for the scroll wiring: its mutations are only
observable in a real browser, so it rebuilds the bundle and runs the Playwright
suite per mutation (`just mutation-check comfyui-gallery-loader
tests/mutations-e2e.json` — six real mutations CAUGHT, the CONTROL correctly
MISSED, so a healthy run exits 1).

### Pack directory name is part of the URL

`web/js/image-picker.js` is served at
`/extensions/comfyui-gallery-loader/js/image-picker.js`. Renaming
the pack directory breaks every fetch the frontend makes. Don't.

### Arbitrary-path endpoints are extension-whitelisted

`/gallery_loader/thumb` and `/gallery_loader/file` accept an absolute
`path` query parameter. They both enforce an extension whitelist
(images for `thumb`, images + common video formats for `file`). When
adding new file types, widen the whitelist explicitly — never read
arbitrary paths without the extension gate.

### Value contract: don't churn input/ workflows

When committing from the modal:

| Source | Committed value | Backward compat |
|---|---|---|
| Input | `subdir/foo.png` (bare relative) | Matches core `LoadImage` exactly. |
| Output | `subdir/foo.png [output]` | Resolved by `get_annotated_filepath`. |
| Temp | `subdir/foo.png [temp]` | Same. |
| VHS path | `/abs/path/foo.png` | Raw absolute, matches VHS expectation. |

Don't switch the Input source to annotated form — existing workflows
serialize bare relative paths and would churn on save/reload.

### The lazy-thumb observer root differs between the two surfaces

`installLazyThumbs`'s `IntersectionObserver` must be rooted on **whatever
element actually scrolls**, and that element is *not* the same in both
frontends:

| Surface | Grid | Scroller | Correct `root` |
|---|---|---|---|
| `gallery_loader.ts` (inline node grid) | `.gl-grid` | `.gl-grid` (`overflow-y: auto`) | the grid |
| `image-picker.ts` (modal) | `.ip-grid` (no overflow clip) | `modal.bodyEl` / `.cmp-body` | **the modal body** |

Rooting on an element with no overflow clip makes the root rectangle that
element's *whole bounding box*, so every card reports as intersecting on the
first callback and the "lazy" load fires for the entire listing at once — one
`/thumb` request per file plus a `src` + `preload=metadata` on every `<video>`.
Measured 400/400 off-screen cards intersecting with the grid as root vs 20/400
with the real scroller; at scale it OOMs the tab. There is a regression test
(`tests/js/image-picker.test.js`) asserting the picker's root. If you move
either grid into or out of a scrolling container, move its `root` with it.

### Scroll position: restored through the kit, remembered per LOCATION

The picker remembers where each folder was scrolled to and puts it back — up,
down, tab, crumb, pin chip, flat-view toggle, and across a close/reopen (the map
is module-level, and deliberately not persisted to localStorage). `locationKey()`
is the slot, and it is the SAME key Safe View's reveal set uses: one notion of
"where you are", including the folder/flat distinction, because those are two
different listings of one directory and an offset measured against one is
meaningless against the other.

The mechanism is `installScrollRestore` from `@laurigates/comfy-modal-kit`,
shared with `comfyui-image-browser` — not a local copy. Four things break the
obvious `modal.bodyEl.scrollTop = n`, all measured in Chromium at a phone
viewport, and the kit's module documents each:

1. **The close path reads a detached element.** The shell removes the dialog and
   only THEN calls `onClose`, so a `scrollTop` read there is 0 in every real
   engine. `rememberScroll()` reads the restorer's mirror instead, and
   `scroller.dispose()` must stay AFTER it in `onClose`.
2. **`scrollTop = n` clamps at the instant of assignment**, so one write is only
   as good as the layout in force. The restorer re-asserts for a bounded
   `SCROLL_RESTORE_FRAMES` and stops on detach.
3. **Restore BEFORE `installLazyThumbs`**, so the observer's first pass is
   computed against the final viewport; observing first queues the top-of-list
   band, which in flat view is thousands of wrong `/thumb` requests. This one is
   **latent** with a synchronous first write — the observer's callbacks are
   async — so `tests/mutations-e2e.json` deliberately does not pin it: swapping
   the two lines was caught on one run of the browser suite and missed on the
   next, and a flaky table entry is worse than none.
4. **Hand the destination INTO `renderGrid({ scrollTo })`** rather than assigning
   after it — `renderGrid`'s own capture belongs to the folder you just left, and
   a later write races the re-assert loop.

Any user gesture that scrolls (pointer/wheel/touch, or a native scroll key
outside a text field) ends a pending restore immediately: a wrong offset beats a
scroller that fights a finger. The kit's default `isTypingTarget` covers the
shell's autofocused search input, which is why no override is passed here.

First-open **centring** on the widget's current image still wins over an empty
slot — that is what the picker is for — but a remembered offset wins over the
centring on a return visit. It now runs in flat view too: it used to be skipped
there because a single bare write was clamped against a not-yet-final layout,
which is exactly what the re-assert loop fixes.

`tests/e2e/` is the only suite that can see any of this. Verified by rebuilding
the bundle from the pre-change `src/image-picker.ts`: **14 of 16 browser tests
fail**, while `bun run test` and `pytest` stay green.

### Listing caps and the extensions clamp

Both `/list` paths are capped and report `truncated`. The cap is applied **after**
an mtime sort, never during the walk — truncating in directory order silently
omits the newest render, which is the one thing the flat view exists to surface.
There is a test that fails against a during-walk cap.

`extensions` is clamped to `IMG_EXTS|VIDEO_EXTS` **in the handler**, not inside
`_parse_extensions`. That helper falls back to `IMG_EXTS` on an empty result, so
moving the clamp into it would re-expand an empty intersection and break
directory mode's `.__none__` sentinel into listing every image. There is a test
named for that trap; the "cleaner" refactor is the wrong one.

### Safe View: the Python matcher is a PORT, and the address is LOGICAL

`_safe_tokens` / `_parse_safe_keywords` / `_is_sensitive` in `gallery_loader.py`
are a deliberate port of the kit's `tokenize` / `parseKeywords` / `isSensitive`
(`comfy-modal-kit/src/safe-view.ts`). The frontend blurs what IT thinks matches
while the backend drops what IT thinks matches, so any divergence surfaces as a
file hidden in one pack and plain in the other over the same bytes — including
across to `comfyui-image-browser`, which carries the identical port. Change one,
change all three.

Two things that look like details and are not:

- **Whole tokens, never substrings.** A substring matcher passes every positive
  test; only the controls (`ass` vs `assets/`, `nsfw` vs `nsfwish.png`) tell
  them apart, and a wrongly-hidden file is indistinguishable to the user from a
  file that simply is not there. Both suites pin the controls.
- **The matched path is the LOGICAL address** — `output/nsfw/2026-08-04`, root
  segment included — never the resolved OS path. Matching the OS path would put
  every segment of `/home/<user>/ComfyUI/output` in the haystack, so a keyword
  of `comfyui` would hide the whole library while the frontend, which never sees
  those segments, kept showing it. `type=path` is the one case where the OS path
  *is* the logical one.

- **A file's `dc:subject` keywords are a third haystack, and each tag is
  TOKENIZED** — `nsfw art` matches the keyword `nsfw`, `assets` still does not
  match `ass`. That is exactly what the kit does (`for (const tag of
  target.tags ?? []) for (const t of tokenize(tag))`); comparing whole tags
  would make this pack disagree with the browser over the same file.

Hiding is applied inside `_probe_newest`, **above** the newest-N cap, and that
is why the filter lives in that function rather than at its two call sites:
filtering after the slice spends the entire budget on rows that are then
dropped, and the user gets a near-empty grid they cannot tell from an empty
folder. `tests/test_safe_view.py` fails with `assert 0 == 3` against that bug.

The keyword tier **cannot** run up there: it needs the XMP read, which is the
expensive probe the cap exists to bound. So the loop probes newest-first and
TOPS UP — a row dropped for its tags is replaced by probing one more — which
keeps the full-page property without paying for a whole-tree read, and costs
exactly the same number of probes as before whenever nothing is tagged.
`PROBE_BUDGET_FACTOR` bounds the pathological case (a whole tree tagged), where
the honest answer is a short page marked `truncated`. A mutation that reverts
the top-up turns a 3-card page into an empty one.

`🙈` (`src/safe-tag.ts`) writes **the user's first configured keyword** through
`POST /gallery_loader/tag`. Not a hidden constant: the filter matches the user's
own list, so any other choice could write a mark their filter does not honour —
and with an empty list the control is not rendered at all rather than writing
the packaged default. The response carries the keywords read back off the file
**after** the write, never an echo of the request; the two differ whenever the
write did not land the way the tap assumed, and painting the guess would show a
mark the file does not carry.

Safe View is **discretion, not access control** — the blur is CSS and the bytes
are still served. Say so wherever it is documented; the README carries the
accepted gaps (plain-text toasts, the full-prompt metadata panel,
folder-name-only matching, the unfiltered canvas preview).

### Flat view: never address a file by bare name

In flat view two subfolders can each hold a `ComfyUI_00001_.png`, so a bare
filename is not an identity. Cards carry `data-idx` into the rendered listing and
handlers resolve the file OBJECT; every per-file address (thumbnail, rating,
committed value, metadata, subpath-label target) goes through `fileSub()`, which
joins the file's own `subpath` onto `state.subfolder`. `dataset.name` is
display/debug only. Reverting either handler to a name lookup fails two tests.

### …and in the pinned view, never address a file by `state.type` either

`fileSub()` has a sibling, **`fileType()`**, and the same law covers both: a
per-file address takes `fileType(f)` + `fileSub(f)`, never `state.type`. Folder
and flat view can get away with reading `state.type` because every card there
lives under one root; **pins span roots**, so on the pinned tab `state.type` is
the synthetic `"pinned"` and reading it is wrong for every card at once — the
picker would commit `a.png [pinned]`, fetch `?type=pinned` thumbnails, and offer
no `📌` at all (`SANDBOXED_TYPES` does not contain it).

The split to keep straight when touching either function:

| Bucket | Reads | Examples |
|---|---|---|
| Per-file address | `fileType(f)` | `thumbForFile`, `setStarRating`, `openMetadata`, `commitFile`, the card `📌`, the `is-selected` match, the subpath label's target |
| Location | `state.type` | which listing to fetch, tab highlight, crumbs, flat-view + pin-this-folder gating, `Use this folder` |

`tests/js/pins.test.js` pins this down; reverting `fileType()` to
`return state.type;` turns four of its cases red (the observed messages are
recorded in that file's header).

### The defang records WHICH upload flag it stripped

`_origUploadFlag` holds `"image_upload"` or `"video_upload"`, not a boolean.
It is the only thing left on a constructed widget that says whether the combo
lists images or videos, and the two ask the backend for different extension
sets — a boolean marker silently gives every video loader the image listing.
Only those two flags are stripped: `audio_upload` and `mesh_upload` combos keep
their native control, because the picker cannot serve them. There are tests for
both halves.

### VHS extension sets are copied, and can go stale

`VHS_VIDEO_EXTS` mirrors VHS's own `video_extensions`
(`videohelpersuite/load_video_nodes.py`: `webm, mp4, mkv, gif, mov`) so the grid
offers exactly what the node's native dropdown does — deliberately **not** this
pack's broader `VIDEO_EXTS`, which would list `.avi`/`.mpg` files the dropdown
never shows. Note `.gif` is in VHS's list and in our `IMG_EXTS`, so it renders
as a still `<img>` thumbnail; that is correct, not a bug. If VHS widens its
list, ours goes stale silently — the symptom is a loadable file the grid won't
show.

### A sandboxed folder value uses `.` for a root, never `""`

`VHS_LoadImages` commits through the same annotated grammar as a file, with the
whole relative path in the name slot (`a/b [output]`). At a root the value is
`.` — `get_annotated_filepath` joins it onto the base dir and `abspath`
normalises it away, whereas `""` serializes as a blank widget value that reads
as "nothing chosen". Note `folder_paths.annotated_filepath` strips **9**
characters for `[output]`, i.e. the suffix *plus the preceding space*, so the
space in `${rel} [${type}]` is load-bearing.

### Frontend hook is version-sensitive

The modal opens via two strategies:

- **A**: `widget.onPointerDown` patch — requires modern frontend's
  click hook (`comfyui-frontend-package >= 1.40`).
- **B**: explicit `📁 Browse` button widget — guaranteed regardless
  of frontend version.

Strategy B is the safety net. If A breaks (e.g. frontend renames the
hook), the button still works. Don't remove the button widget.

## Dev workflow

### Setup

```sh
uv sync --group dev          # install ruff, pytest, pre-commit
bun install                  # install TS toolchain + @laurigates/comfy-modal-kit
pre-commit install
```

### Build the frontend

The served frontend is `web/dist/index.js`, emitted from `src/` by bun.
`web/dist/` is **tracked in git** — rebuild it and commit it in the SAME commit
as any `src/` change. It is tracked deliberately: ComfyUI-Manager updates over
git, and a `fetch && merge --ff-only` cannot pull an ignored path, so an ignored
bundle would report the update as successful while ComfyUI kept serving the
stale one. CI fails on a `web/dist` that is stale vs `src/`.

```sh
bun run build                # bun build src/index.ts → web/dist/ (+ copies web/css)
```

### Lint, typecheck, format

```sh
uv run ruff check .
uv run ruff format .
bunx biome check .
bunx biome check --write .
bun run typecheck            # tsc --noEmit against the frontend types
bun run knip                 # dead-export / unused-dependency check
```

### Tests

```sh
uv run pytest -v             # full backend suite
bun run test                 # Vitest/jsdom (tests/js/) — no layout engine
just test-e2e                # builds, then Playwright/Chromium (tests/e2e/)
bun run test:e2e             # the browser suite alone (serves the CURRENT web/dist — build first)
just check                   # lint + all three, the local CI gate
```

The jsdom/browser split is load-bearing: `tests/js/` cannot fail for anything
layout-dependent, so scroll, clamping and lazy-load behaviour are asserted only
in `tests/e2e/` (Chromium-only, so iOS momentum scrolling stays uncovered).

### JavaScript tests

The Vitest harness covers the pure helpers `fuzzyScore` / `fuzzyRank`,
now imported from `@laurigates/comfy-modal-kit` (the kit replaced the
former vendored `modal-fuzzy.js` / `modal-shell.js`). DOM-dependent code
in `src/image-picker.ts` and `src/gallery_loader.ts` is **not**
unit-tested — it's covered by the smoke matrix below. See
`docs/trps/regression-gaps-initial-scaffold.md` for the rationale and the
trigger conditions for promoting DOM coverage.

Test files live under `tests/js/` and follow `*.test.js`. The
`tests/js/__mocks__/app.js` stub is wired through `vitest.config.js`
(aliased on the `/scripts/app.js` specifier) so future picker-module
tests can import the ComfyUI `app` without a real frontend. The
fuzzy-matcher tests don't need that hook today.

jsdom suites: `image-picker.test.js` (lazy-thumb root, flat view, folder pins,
highlighting), `video-loaders.test.js` (node detection), `pins.test.js` (the
pinned tab + the `fileType()` address sweep) and `pins-migration.test.js` (the
one-shot localStorage drain — its own file because the migration guard is
module-level, so a second run in the same registry is a no-op by design).

`tests/js/setup-jsdom.js` (a `setupFiles` entry) restores `localStorage`: Node
22+ defines its own global accessor that is `undefined` without
`--localstorage-file`, and vitest skips populating jsdom's real one over a name
already on `globalThis` — without the shim every jsdom file dies in `beforeEach`
on `localStorage.clear()`. Seen on Node v26.5.0.

```sh
bun run test                 # one-shot run (CI mode)
bun run test:watch           # watch mode for TDD
```

Note: `package.json`, `node_modules/`, and `src/` are **dev/source-time**.
Only the built `web/dist/` is served to ComfyUI; the kit is inlined into
the bundle (nothing under `node_modules/` is served).

### Iterating on JS / CSS

Changes under `src/` (or `web/css/`) require a **`bun run build`** to
refresh `web/dist/`, then a browser hard-refresh
(Ctrl+Shift+R / Cmd+Shift+R) — **no ComfyUI restart**. Changes to
`gallery_loader.py` (backend node, endpoints) **do** require a restart:

```sh
sudo -n systemctl restart comfyui.service
```

### Endpoint reachability check

```sh
curl -s -o /dev/null -w "%{http_code}\n" \
  http://127.0.0.1:8188/extensions/comfyui-gallery-loader/index.js
# Expected: 200

curl -s http://127.0.0.1:8188/gallery_loader/base | jq .
# Expected: { ok: true, base_path: "...", input_dir: "...", ... }
```

### Screenshots

The README's two PNGs are regenerated by a containerized Playwright
pipeline under `screenshots/`:

```sh
just screenshots
```

This builds a Docker image (pinned ComfyUI + CPU torch + Playwright/
Chromium) and runs it, dropping `docs/picker.png` and `docs/gallery.png`
at `docs/` root. First build ~4 min; cached rebuild ~30 s. The grid
renders real files, so `seed_images.py` paints sample images into
`input/`/`output/`/`temp/` at build time.

**Don't hand-edit `docs/picker.png` / `docs/gallery.png`.** Edit
`screenshots/capture.mjs`, `screenshots/workflow.json`, or
`screenshots/seed_images.py` and regenerate. The Dockerfile COPY target
`custom_nodes/comfyui-gallery-loader` is the served URL prefix — don't
rename it. No CI auto-regeneration; PNGs are committed and refreshed
manually on the same host. See `screenshots/README.md` for pins and
troubleshooting.

### Smoke matrix when changing the picker

After non-trivial frontend changes, verify in browser:

| Node | Expected |
|---|---|
| `LoadImage` | Tabs (Input/Output/Temp); selecting from Output commits `foo.png [output]`. |
| `GalleryLoadImage` | Inline grid renders on the node; switching source chips still works. Sort choice persists and matches the modal's (shared `:sort` key, same ten options). |
| `VHS_LoadImagePath` | 📁 button opens path-mode modal at base dir; selecting a file commits absolute path. |
| `VHS_LoadImagesPath` | 📁 button opens modal in directory mode; footer "Use this folder" commits the absolute dir. |
| `VHS_LoadVideoPath` | Same as image path, with video poster thumbs. |
| `LoadVideo` (core) | Tabs; grid shows only videos (no PNGs). Picking from Output commits `clip.mp4 [output]` and the node still executes. |
| `VHS_LoadVideo` / `VHS_LoadVideoFFmpeg` | Same, and a `.gif` in the folder shows as a still thumbnail rather than a `<video>`. |
| `VHS_LoadImages` | Opens inside the currently selected folder in directory mode; file cards inert; "Use this folder" commits `frames` (input) / `frames [output]`. At a root it commits `.` and the node still loads. |
| Flat view (`≣`) | On a sandboxed tab, folds the current folder's subtree into one newest-first grid; each card labelled with its subpath. Tapping a label drops to folder view there. Picking a nested file commits `sub/dir/foo.png [output]`. Hidden on the path tab and in directory mode. Preference persists; a huge tree toasts "truncated". |
| Flat view — same-named files | Two subfolders each holding `ComfyUI_00001_.png`: clicking each card commits ITS OWN path, and starring one rates only that one. |
| Metadata (`ⓘ`) | On an image card (including on a path picker) → in-dialog overlay, painted immediately with "Reading metadata…", then a source line, one row per recognised field with its own Copy, Copy all, and a collapsed raw disclosure. No `ⓘ` on video cards. A read failure closes the overlay FIRST, then toasts. |
| Pins (`📌`) — folders | Toolbar `📌` pins the current folder; chips render on their own toolbar row — tap to navigate, ✕ to unpin. Hidden on a path picker. Persist across reloads **and across browsers**: the list is server-side (`<user_dir>/comfy-pins.json`), not `localStorage`. An old `localStorage` list is drained into it once on first open and the key removed. |
| Pins (`📌`) — media | `📌` on a file card pins that file (highlighted when already pinned); the tap must NOT commit or close. The **📌 pinned** tab shows every pinned file across roots, each labelled with its full address (`output/2026-08-04/`) — tapping the label navigates there, **tapping the card commits in one tap** (a pinned `output/…/a.png` commits `…/a.png [output]` with no navigation). Tab hidden in directory mode; flat view and the folder-`📌` are hidden while on it. |
| Scroll position | Scroll deep in a folder, enter a subfolder (starts at the top), come back → the parent is where you left it; descend again → the subfolder's own position. Star a card deep in a listing → the grid does not jump. **Close the picker deep in a folder and reopen it** → back where you left it, not at the top. A restored offset **holds** for ~200 ms of thumbnails landing rather than drifting up. Flick or press End immediately after a restore → the view follows the input. Toggling ≣ keeps a separate position per view. Changing sort/search starts at the top and stays there. Opening the picker fresh centres the widget's current image (in flat view too). |
| Pins — stale + cross-device/pack | Delete a pinned file on disk, reopen: the card renders **dimmed**, refuses to commit, and `Prune missing` drops it. Pin on the phone → appears on the desktop after a reopen (and vice versa). Pin in `comfyui-image-browser` → appears here, same file on disk. Pins are **per-install, not per-user**. |

## Releases

See `RELEASE-CHECKLIST.md` for the full playbook. High level:

- Semver in `pyproject.toml` — patch for backend fixes, minor for UI
  features, major for breaking endpoint or value-format changes.
- Push to `main` with a version bump → `Comfy-Org/publish-node-action`
  auto-publishes to Comfy Registry.

## Things not to do

- **Don't read arbitrary paths without the extension whitelist.** The
  `/thumb` and `/file` endpoints are the security perimeter; widen
  the allowed extensions explicitly.
- **Don't break the value contract** for the Input source (bare
  relative form). It's how existing workflows serialize.
- **Don't add a Python dependency.** Backend libs must be the ones
  ComfyUI core already ships.
- **Don't rename the pack directory.** It's in the served URL.
- **Don't remove the explicit `📁 Browse` button.** It's the
  Strategy-B safety net for frontend changes.
