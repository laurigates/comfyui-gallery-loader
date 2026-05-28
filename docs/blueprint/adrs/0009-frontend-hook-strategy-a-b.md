---
id: ADR-0009
created: 2026-05-28
status: Accepted
domain: frontend-framework
relates-to: [PRD-001, ADR-0002]
---

# Frontend Hook Strategy A + B (onPointerDown + explicit Browse button)

## Status

Accepted

## Context

Stock `LoadImage` and the VHS path widgets are rendered by the ComfyUI frontend's Vue + LiteGraph layer. To intercept a tap/click on those widgets and open the modal, the pack patches `widget.onPointerDown` — a hook added in `comfyui-frontend-package >= 1.40`.

The hook is version-sensitive. If the frontend renames it, removes it, or changes its signature, the picker would silently fail to open and the user would be stuck with the native dropdown (LoadImage) or a bare path field (VHS) with no indication that gallery-loader was supposed to do something.

For sister pack `comfyui-sampler-info`, the same hook is used and a "silent stop" was considered acceptable — the additive tooltip enrichment continues to work regardless. For gallery-loader, the silent-stop is much worse: the picker is the **only** UI; without it, the pack is functionally invisible.

## Decision

Two strategies for opening the modal, both wired in parallel:

| Strategy | Mechanism | Stability |
|---|---|---|
| **A** | `widget.onPointerDown` patch | Requires `comfyui-frontend-package >= 1.40` |
| **B** | Explicit `📁 Browse` button widget added to the node | Always works (we own this widget) |

Both strategies open the same modal. When Strategy A fires (because the hook still exists and the user tapped the original widget), the modal opens. When Strategy B fires (because the user clicked the explicit button), the modal opens. They share the same `openPicker` function — no duplicated UI logic.

**Never remove the explicit `📁 Browse` button.** It's the safety net.

## Consequences

- **Positive**: the pack survives `onPointerDown` removal or renaming. Users always have a working entry point via the visible button.
- **Positive**: the button is discoverable — users can see there's a gallery-loader feature on the node. Strategy A alone has no UI affordance.
- **Negative**: dual entry points are slightly redundant on nodes that work via Strategy A. Acceptable — the button is a small inline widget, not a heavyweight UI element.
- **Negative**: requires the pack to add a custom widget to the affected nodes. Mitigated by the small footprint and the clear ownership boundary.

## Tests

The smoke matrix in `.claude/rules/testing.md` includes Strategy A entries (tap the widget directly) for nodes that support it, and Strategy B entries (tap the 📁 button) for VHS path nodes specifically (where the bare STRING widget has no `onPointerDown` to patch).
