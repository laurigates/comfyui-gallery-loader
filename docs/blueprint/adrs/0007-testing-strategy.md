---
id: ADR-0007
created: 2026-05-28
status: Accepted
domain: testing
relates-to: [PRD-001, ADR-0001, ADR-0003]
---

# Testing Strategy — pytest for backend + Vitest for pure frontend helpers

## Status

Accepted

## Context

The pack has two runtimes (Python backend, JS frontend). Test investment for each:

- **Python backend** — small, pure-helper-heavy (`_parse_extensions`, `_resolve_input_string`, `_resolve_listing_base`, `_is_image_file`). Pure-helper coverage is high-value because it locks in the value-format contract (ADR-0008) and the extension-whitelist behaviour (ADR-0004) — both of which are workflow-stability commitments.
- **JS frontend** — split between pure helpers (`modal-fuzzy.js`) and DOM-heavy code (`modal-shell.js`, `image-picker.js`, `gallery_loader.js`). The fuzzy matcher is provable without a DOM; the rest needs a browser.

A full headless-browser test harness (Playwright, Vitest with `jsdom`) was considered but rejected for the initial scaffold — the cost-vs-coverage payoff is marginal for a small UI surface, and the dev-experience tax (extra deps, slower CI) doesn't yet justify it.

## Decision

Two test runners, each covering what it can reliably cover:

- **pytest** for Python — runs against `tests/test_helpers.py` (pure helpers) and `tests/test_init.py` (loader stub).
- **Vitest** for JS pure helpers — runs against `tests/js/modal-fuzzy.test.js` (fuzzy scorer and ranker).

DOM-dependent frontend code is covered by the **live smoke matrix** documented in `CLAUDE.md` and `.claude/rules/testing.md`. The smoke matrix is a manual checklist run before non-trivial picker changes.

CI runs both test runners as separate jobs (`test` for pytest, `test-js` for Vitest) so each surfaces failures independently. `just test` (and `just check`) chain them locally.

## Consequences

- **Positive**: high-value pure-helper coverage with zero browser dependency.
- **Positive**: Vitest harness is a forward-investment — adding DOM-dependent tests later is "add `jsdom` and write the tests," not "set up a test runner from scratch."
- **Positive**: the smoke matrix is a documented checklist, not implicit knowledge. Contributors know what to verify in the browser.
- **Negative**: DOM-dependent regressions can sneak through. Mitigated by the smoke matrix being part of the PR-review expectation.
- **Negative**: two runners means two `package.json`-style configs (`pyproject.toml` and `package.json`). Acceptable — `package.json` is dev-only.

## Follow-up

If the smoke matrix starts catching regressions reactively (i.e., they reach `main` first), promote DOM coverage:
- Add `jsdom` as a Vitest environment.
- Cover `highlightMatches`, modal-shell DOM helpers, and picker source-tab state.

Track that follow-up in `docs/trps/regression-gaps-initial-scaffold.md`.
