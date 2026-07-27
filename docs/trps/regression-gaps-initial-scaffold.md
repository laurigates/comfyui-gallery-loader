---
id: TRP-001
created: 2026-05-28
status: Active
relates-to: [PRD-001, ADR-0007]
---

# Initial Scaffold — Coverage Gaps from First Feature Commit

## Status

Active

## Context

ADR-0007 documents the testing strategy: pytest for backend pure helpers + Vitest for the pure JS fuzzy matcher, with DOM-dependent code covered by a manual smoke matrix. This TRP enumerates the **gaps** that the initial scaffold leaves uncovered, so they can be picked up incrementally if/when the smoke matrix starts catching regressions reactively.

## Gap Inventory

### Gap 1 — `modal-fuzzy.highlightMatches` (deferred)

**What it does**: wraps matched characters in a target string with `<span class="cmp-match">…</span>` spans, returning a `DocumentFragment` ready to append.

**Why uncovered**: requires `document.createElement` and `document.createDocumentFragment` — needs a DOM. Vitest's default `node` environment provides neither.

**Cost to cover**: add `jsdom` as a Vitest environment (`environment: "jsdom"` in `vitest.config.js`), or switch only this test file to a `// @vitest-environment jsdom` pragma. Add `jsdom` to `devDependencies`.

**Recommendation**: defer. The function is short (~20 lines) and visually verifiable in the smoke matrix. Promote if a span-rendering regression slips through.

### Gap 2 — `modal-shell.js` DOM helpers

**What it does**: builds the modal backdrop, dialog, toolbar (filter input, source-tab chips, close button), body (grid container), and footer. Handles ESC key, backdrop dismiss, focus trap, single-modal discipline.

**Why uncovered**: heavily DOM-dependent. Same constraints as Gap 1, with a much larger surface (300+ LOC).

**Cost to cover**: medium-to-high. Would need jsdom + a small fixture system to assert backdrop/dialog presence, ESC handling, focus trap behaviour. Some behaviours (the synthesized-click-after-touchend bug) probably can't be reproduced in jsdom and need a real browser (Playwright).

**Recommendation**: defer until the smoke matrix shows recurring regressions. If the dismiss-on-click bug from commit `4249353` (sampler-info equivalent) recurs in gallery-loader, that's the trigger.

### Gap 3 — `image-picker.js` integration logic

**What it does**: detects widget shape (combo vs VHS path), patches `onPointerDown`, builds the explicit Browse button, fetches listings via `/gallery_loader/list`, renders cards, handles source-tab switching, commits the value.

**Why uncovered**: end-to-end behaviour that needs a running ComfyUI to actually verify. Even with jsdom, the integration is too coarse for unit tests to be useful.

**Cost to cover**: high — needs Playwright against a running ComfyUI. Out of scope for the scaffold.

**Recommendation**: defer indefinitely for the *integration* surface. The smoke matrix is the right tier for widget detection, tab switching, and value commit.

**Partially promoted (2026-07)** — `tests/js/image-picker.test.js`. Trigger conditions 1 and 3 both fired: the lazy-thumb `IntersectionObserver` was rooted on `.ip-grid`, which has no overflow clip, so every card reported as intersecting and the entire listing's thumbnails loaded at once. It reached `main` and surfaced only when a user hit the identical bug in the sibling `comfyui-image-browser` pack, which then needed the same assertion. `openImagePicker` is now exported as a test seam and the file runs under a `// @vitest-environment jsdom` pragma (`jsdom` is a devDependency).

Scope of the promotion is deliberately narrow — the observer's **root** and the parked-`data-src` consequence, i.e. the properties that are invisible in review and fatal at scale. Widget detection, tab switching, and value commit stay on the smoke matrix.

### Gap 4 — `gallery_loader.js` inline-grid logic

Same considerations as Gap 3 — integration code. Smoke matrix is the right tier.

### Gap 5 — Endpoint round-trip tests

**What's covered**: pure helpers (`_parse_extensions`, `_resolve_input_string`, `_resolve_listing_base`, `_is_image_file`) in `tests/test_helpers.py`.

**What's not**: the four aiohttp handlers themselves (`gallery_list`, `gallery_base`, `gallery_thumb`, `gallery_file`). Their bodies call pure helpers but also exercise aiohttp request/response shapes.

**Cost to cover**: medium. Needs aiohttp test client setup (`aiohttp.test_utils.AioHTTPTestCase`). Promotes coverage but requires fixture work since `PromptServer.instance` is a ComfyUI global.

**Recommendation**: defer. The pure helpers are the heart of the logic; the handler bodies are thin wrappers. Promote if an endpoint regression slips past pure-helper tests.

## Trigger Conditions for Promotion

Promote a gap to covered status when one of these fires:

1. A regression in the gap's code area reaches `main` and isn't caught until users report it.
2. A refactor in the gap's code area would benefit from a safety net.
3. A second pack (sibling to gallery-loader / sampler-info) needs the same coverage and shared infrastructure becomes worth it.

## What This Doc Is Not

- Not a test plan. It's a record of intentional gaps and the trigger conditions for closing each one.
- Not a backlog. Items here aren't actively scheduled — they're parked until a trigger fires.
- Not exhaustive. New gaps may emerge as features are added.
