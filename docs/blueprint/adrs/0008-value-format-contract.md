---
id: ADR-0008
created: 2026-05-28
status: Accepted
domain: api-design
relates-to: [PRD-001, ADR-0004]
---

# Value-Format Contract per Source (bare relative / annotated / absolute)

## Status

Accepted

## Context

The picker commits a value to whatever widget it's bound to (stock `LoadImage.image`, VHS `STRING` path widget, `GalleryLoadImage.image`). The downstream resolver depends on the format:

- Core `LoadImage` reads `widget.value` as a bare relative path under `input/`. That's how every existing workflow serializes it.
- `folder_paths.get_annotated_filepath(value)` accepts annotated form `foo.png [output]`, `foo.png [temp]`, `foo.png [input]` and resolves to the right directory.
- VHS path widgets accept raw absolute paths — they don't interpret annotated form.

A naive "always commit annotated form" approach would standardize the picker but **break workflow stability**: existing `LoadImage`-based workflows would suddenly serialize `foo.png [input]` instead of `foo.png`, causing every saved JSON to churn on save/reload.

## Decision

Commit different formats depending on the source:

| Source | Committed value | Resolved by |
|---|---|---|
| Input (stock `LoadImage`) | `subdir/foo.png` (bare relative) | core `LoadImage` |
| Output | `subdir/foo.png [output]` | `folder_paths.get_annotated_filepath` |
| Temp | `subdir/foo.png [temp]` | `folder_paths.get_annotated_filepath` |
| VHS path | `/abs/path/foo.png` | VHS path widget (raw absolute) |
| `GalleryLoadImage` | Any of the above; resolver is `_resolve_input_string` | gallery_loader.py |

`GalleryLoadImage._resolve_input_string` accepts all three formats by detecting the trailing annotation and falling back to absolute or relative resolution.

## Consequences

- **Positive**: existing `LoadImage` workflows are bit-identical after picker substitution. Save/reload does not churn diffs.
- **Positive**: VHS workflows are also bit-identical — the picker just commits the same raw absolute path the user would type.
- **Positive**: Output/Temp picking from stock `LoadImage` gets the annotated form, which is the *correct* form for those sources (core would expect it too if `LoadImage` had a source selector).
- **Negative**: the rule is non-obvious — three formats, three sources. Mitigated by the rule table in `.claude/rules/api-conventions.md` and the CLAUDE.md hard-rules section.
- **Negative**: any future picker entry point must respect the contract. New entry points must commit the format the underlying widget expects, not a unified format.

## Status of Bump on Change

Changes to this contract are **major version bumps** per ADR-0005's versioning policy. A breaking change here breaks every saved workflow that uses the affected source.
