---
id: ADR-0003
created: 2026-05-28
status: Accepted
domain: build-tooling
relates-to: [PRD-001, ADR-0001, ADR-0002]
---

# Multi-File JavaScript Organization (modal-shell extraction)

## Status

Accepted

## Context

Two entry points (`GalleryLoadImage` inline grid + modal-over-`LoadImage`) and a third (VHS path integration) all share a card-grid picker UI. The picker UI has a few distinct concerns that don't naturally belong together:

- **Modal shell** — backdrop, dialog mounting, ESC handling, toolbar, filter input, footer. Generic; no picker-specific state.
- **Fuzzy filter** — pure scoring helpers (`fuzzyScore`, `fuzzyRank`, `highlightMatches`). No DOM dependencies beyond highlightMatches.
- **Picker logic** — source tabs, listing fetch, card rendering, value commit. Picker-specific.
- **Inline-grid logic** — same picker UI but rendered inline on a custom node rather than in a modal.

A single-file approach (like sampler-info's ~900-line `sampler-info.js`) would compile the lot. But the modal shell and fuzzy matcher are deliberately generic — they could be reused in future packs (or extracted into a shared frontend pack).

## Decision

Split the frontend into four ES modules, each with a single responsibility:

| File | Role | Imports |
|------|------|---------|
| `gallery_loader.js` | Inline-grid for `GalleryLoadImage` | ComfyUI `app.js` |
| `image-picker.js` | Modal for stock `LoadImage` + VHS path nodes | `app.js`, `modal-shell.js`, `modal-fuzzy.js` |
| `modal-shell.js` | Reusable modal dialog primitive | none |
| `modal-fuzzy.js` | fzf-lite fuzzy matcher | none |

`modal-shell.js` and `modal-fuzzy.js` have **no picker-specific imports**. They are extraction-ready into a shared pack (see comment at `modal-fuzzy.js:10`).

## Consequences

- **Positive**: pure helpers in `modal-fuzzy.js` carry real Vitest coverage (see ADR-0007). The fuzzy matcher is provable without a browser.
- **Positive**: the reuse axis is explicit. Adding a future pack with a card-grid picker is a `cp modal-shell.js modal-fuzzy.js` away from a starting point.
- **Negative**: four files vs one — more navigation surface. Mitigated by clear responsibility boundaries and `paths:` frontmatter on `.claude/rules/code-style.md`.
- **Negative**: ES module imports go through the URL path (`/extensions/comfyui-gallery-loader/js/...`) — renaming the pack directory breaks every import. Same risk as the single-file approach; no worse.
