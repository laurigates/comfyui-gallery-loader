---
id: ADR-0006
created: 2026-05-28
status: Accepted
domain: deployment
relates-to: [PRD-001, ADR-0005]
---

# CI/CD via GitHub Actions (inline, not reusable workflows)

## Status

Accepted

## Context

The `laurigates/` org has a centralized [reusable-workflow library](https://github.com/laurigates/.github) for release-please, container builds, Claude PR review, security scans, etc. The general org rule (`~/.claude/rules/ci-cd-workflows.md`) says repos *should* call those reusable workflows rather than inlining the same logic.

Sister pack `comfyui-sampler-info` doesn't call any reusable workflows yet — it has inline jobs for lint-python, lint-js, test, test-js, security. The two packs are deliberately kept symmetric so updates land in lockstep and a future third pack can copy from either.

## Decision

Inline CI jobs in `.github/workflows/ci.yml` rather than calling reusable workflows. Match sampler-info's job set exactly: `lint-python`, `lint-js`, `test`, `test-js`, `security`.

`.github/workflows/publish.yml` does call an external action (`Comfy-Org/publish-node-action@v1`), but that's a Marketplace action, not an org reusable workflow.

## Consequences

- **Positive**: gallery-loader and sampler-info stay symmetric. Edits to either pack's CI can be applied to the other by copy-paste.
- **Positive**: no dependency on `laurigates/.github` for the day-to-day CI loop. The pack is self-contained.
- **Negative**: drift risk. If a security/lint config improves in `laurigates/.github`, both packs need manual updates.
- **Negative**: violates the org-wide preference for reusable workflows. Acceptable as long as both packs migrate together; flag as a follow-up rather than splitting now.

## Follow-up

When/if both packs migrate to reusable workflows, do them in lockstep. Do not split the symmetry by migrating one pack and leaving the other behind.
