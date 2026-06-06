---
id: ADR-0010
date: 2026-06-06
status: Accepted
deciders: Lauri Gates
domain: build-tooling
supersedes:
  - ADR-0001
  - ADR-0003
relates-to:
  - PRD-001
  - ADR-0001
  - ADR-0002
  - ADR-0003
  - ADR-0005
  - ADR-0006
  - ADR-0007
  - ADR-0009
github-issues: []
name: blueprint-derive-adr
---

# ADR-0010: Adopt TypeScript + bun build (supersedes ADR-0001, ADR-0003)

## Decision Drivers

- The vanilla-JS frontend (ADR-0001) and its multi-file split (ADR-0003) grew
  the negative consequence both ADRs named explicitly: **no static type
  checking**. The pack reaches deep into the minified ComfyUI frontend's
  LiteGraph widget/node objects (`widget.onPointerDown`, `widget.callback`,
  `node.widgets`, `node.addDOMWidget`, `app.graph._nodes`, `app.canvas`).
  Those accesses are exactly where a frontend-version bump silently breaks the
  pack (the "Frontend hook is version-sensitive" hard rule). Type checking
  against `@comfyorg/comfyui-frontend-types` turns a class of those breakages
  into compile errors.
- A bun-externalization spike confirmed the toolchain keeps the
  zero-runtime-bundle property for the host's served module: `bun build
  ./src/index.ts --target browser --format esm --outdir web/dist --external
  '/scripts/*'` emits browser-clean ESM with the `/scripts/app.js` runtime
  import left **unbundled** (resolved at runtime against ComfyUI's served
  module). This is the property ADR-0001 valued — the browser still loads a
  plain ES module, ComfyUI still serves it as a static file — now with a typed
  source.
- ADR-0003 split the modal shell + fuzzy matcher into deliberately-generic,
  extractable files (`modal-shell.js`, `modal-fuzzy.js`) precisely so they
  *could* become a shared pack. That extraction has now happened upstream as
  **`@laurigates/comfy-modal-kit`**. This pack vendored those two files; it now
  consumes the kit as an npm dependency and bun **inlines** the kit's code into
  `web/dist/index.js` (the kit is NOT externalized — only `/scripts/*` is).
  ADR-0003's "keep them extractable" motivation is fully realized, so its
  multi-file-vendored organization is superseded.
- ADR-0007 (Testing Strategy) already introduced a `package.json` + Vitest, so
  ADR-0001's "no build / no `node_modules`" premise no longer held in full.
  Adding a build step on an existing dev toolchain is a smaller delta than the
  originals assumed.

## Considered Options

1. **TypeScript source in `src/`, built to `web/dist/` via `bun build`** —
   typed authoring, browser-ESM output, `/scripts/*` externalized, the
   `@laurigates/comfy-modal-kit` primitives inlined.
2. **Stay on multi-file vanilla JS (ADR-0001 + ADR-0003 status quo)** — no
   build, no types, vendored modal primitives.
3. **TypeScript with `tsc` emit instead of `bun build`** — `tsc` can emit ESM
   but does not understand the `--external '/scripts/*'` runtime-import concept
   and would not strip/keep the served-path import cleanly; it is a type
   checker first, a bundler never. It also would not inline the kit.

## Decision Outcome

**Chosen option**: "TypeScript source in `src/`, built to `web/dist/` via
`bun build`". The spike proved the output preserves the runtime contract, and
the type checker pays for itself at the frontend seam. `tsc --noEmit` is the
type gate; `bun build` is the emit. The two are decoupled — `tsc` never emits,
`bun` never type-checks — which keeps each fast and single-purpose.

### Build & serve mechanics

- **Source**: `src/index.ts` (the lone bun-build entry; imports both
  extension modules for their `app.registerExtension` side-effects),
  `src/gallery_loader.ts` (port of `web/js/gallery_loader.js`),
  `src/image-picker.ts` (port of `web/js/image-picker.js`), and
  `src/comfyui-shims.d.ts`.
- **Shared primitives**: `@laurigates/comfy-modal-kit` (`openModalShell`,
  `fuzzyScore`) replaces the vendored `web/js/modal-shell.js` +
  `web/js/modal-fuzzy.js`. The kit preserves the original export names, so call
  sites are unchanged.
- **Type gate**: `bun run typecheck` → `tsc --noEmit` against
  `@comfyorg/comfyui-frontend-types` (dev dependency).
- **Emit**: `bun run build` →
  `bun build ./src/index.ts --target browser --format esm --outdir web/dist
  --external '/scripts/*'`, then copies `web/css/` → `web/dist/css/` (the
  inline-grid stylesheet the frontend fetches at
  `/extensions/comfyui-gallery-loader/css/gallery_loader.css`). The kit is
  inlined into `web/dist/index.js`; only `/scripts/*` stays external.
- **Serve**: `__init__.py` sets `WEB_DIRECTORY = "./web/dist"`. ComfyUI serves
  that tree at `/extensions/comfyui-gallery-loader/`, so the built JS is at
  `/extensions/comfyui-gallery-loader/index.js` and the CSS at
  `/extensions/comfyui-gallery-loader/css/gallery_loader.css`. The Python
  endpoints (`/gallery_loader/{list,base,thumb,file}`) and the
  `EXT_NAME`-derived fetch paths are unchanged.
- **Distribution**: `web/dist/` is git-ignored (it is generated). The Comfy
  Registry tarball includes it via `[tool.comfy] includes = ["web/dist"]`, and
  CI (`publish.yml`) runs `bun run build` before `publish-node-action` so the
  artifact exists at publish time.

### Type-seam notes (for future maintainers)

- `@comfyorg/comfyui-frontend-types` exports `ComfyApp` at the module root but
  **not** `LGraphNode` / `LGraphCanvas` / the widget interfaces (declared
  internally, un-exported). The pack models the small surface it touches with
  local structural interfaces (`GalleryNode`, `GalleryWidget`, `PickerNode`,
  `PickerWidget`) rather than importing un-exportable types.
- TypeScript will not match an ambient `declare module` against a rooted
  (`/scripts/app.js`) path specifier. A `paths` mapping in `tsconfig.json`
  points that import at `src/comfyui-shims.d.ts` for type resolution; the
  emitted import string stays `/scripts/app.js` and `--external '/scripts/*'`
  keeps it unbundled.

### Positive Consequences

- Static type checking at the version-sensitive frontend seam — the single
  largest source of silent breakage now has a compile-time gate.
- Output is still plain browser ESM served as a static file; no runtime
  bundler, no framework, no change to how ComfyUI loads the extension.
- The vendored modal primitives are gone; the pack consumes the shared kit and
  inlines it, so there is a single upstream source of truth for the modal
  shell + fuzzy matcher.
- The Vitest suite (ADR-0007) now imports `fuzzyScore`/`fuzzyRank` from the kit
  directly; the pure-helper coverage carries over with no behavioural change.
- `knip` + `tsc` + Vitest + Biome give a complete local gate chain alongside
  the unchanged ruff + pytest backend gates.

### Negative Consequences

- The "edit → hard-refresh" loop now requires a `bun run build` step (the
  served file is `web/dist/index.js`, not the source). Mitigated by a fast
  (~5ms) incremental build.
- A build artifact must be present for the screenshot pipeline and the registry
  publish; both are wired to build first, but a fresh checkout has no
  `web/dist/` until `bun run build` runs.
- One more dev dependency set (`typescript`, `@comfyorg/comfyui-frontend-types`,
  `knip`) plus a runtime dependency on `@laurigates/comfy-modal-kit`, and a
  `tsconfig.json` to maintain.

## Pros and Cons of Options

### TypeScript + bun build

- ✅ Static types at the frontend seam
- ✅ Browser-ESM output preserves the runtime contract (spike-confirmed)
- ✅ Decoupled type gate (`tsc --noEmit`) and emit (`bun build`)
- ✅ Consumes + inlines the shared `@laurigates/comfy-modal-kit`
- ❌ Adds a build step to the edit-refresh loop
- ❌ Generated artifact must be built before publish / screenshots

### Stay on multi-file vanilla JS (ADR-0001 + ADR-0003)

- ✅ Zero build toolchain
- ❌ No type safety at the exact place breakage happens
- ❌ Modal primitives stay vendored; the extraction ADR-0003 anticipated never
  lands
- ❌ ADR-0009 already eroded the "no package.json" premise

### TypeScript with `tsc` emit

- ✅ Single tool for typecheck + emit
- ❌ `tsc` is not a bundler; the `/scripts/*` externalize and kit-inline
  concepts are bundler features
- ❌ Worse fit than `bun build` for the browser-ESM-with-external target

## Links

- Bun externalization spike: `bun build ./src/index.ts --target browser
  --format esm --outdir web/dist --external '/scripts/*'` (PASSED — kit
  inlined, `/scripts/*` external)
- `CLAUDE.md` § "File layout", § "Dev workflow"
- ADR-0001 (Project Language) and ADR-0003 (Multi-File JS Organization) —
  superseded by this ADR
- ADR-0007 (Testing Strategy — pytest + Vitest) — the JS tests now import the
  kit's pure helpers

---
*Authored as part of the TypeScript + bun build migration.*
