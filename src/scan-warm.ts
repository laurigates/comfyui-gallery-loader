// scan-warm.ts — Safe View's fast cache warmer, driven by the `executed`
// websocket event. A PORT of comfyui-image-browser's `src/scan-warm.ts`; the two
// packs write into the same `<user_dir>/comfy-safeview.sqlite`, so either one
// warming a render serves both.
//
// The prompt tier answers from a persistent server-side cache. That cache has
// two warmers and BOTH are needed:
//
//   * the backend's background sweep, which covers the BACKLOG — everything
//     already on disk when the tier is first switched on — and then finishes;
//   * this listener, which covers FRESH RENDERS the instant they land, but only
//     while a browser tab is open.
//
// Neither subsumes the other: the sweep cannot see a render that happens after
// it completes, and this cannot see a library that predates the tab. Without
// this half, the file a user just generated — the most visible card in the grid
// — would be `"unscanned"`, and therefore blurred, until the next sweep.
//
// Shapes taken from the shipped frontend (verified in image-browser's port):
//   * `dispatchCustomEvent(msg.type, msg.data)` — the payload is `event.detail`.
//   * `zExecutedWsMessage` is `{node, display_node, prompt_id, output}`.
//   * `zOutputs` carries `images`, `video` AND `audio` arrays and is
//     `.passthrough()`, so an outputs object may hold keys this has never seen.
//   * `zResultItem` marks EVERY field optional, `filename` included, so each
//     field is checked before use rather than destructured blind.
//
// `video` is swept alongside `images`: the backend's metadata reader handles
// MP4/MOV/M4V and WebM/MKV, and skipping videos would leave every fresh clip
// permanently unscanned — and therefore permanently blurred. `audio` is skipped:
// no audio container has a reader, so posting one buys a guaranteed skip.

import {
  readSafeViewConfig,
  SAFE_VIEW_SETTINGS,
  SANDBOXED_TYPES,
  type SafeViewSettingHost,
} from "@laurigates/comfy-modal-kit";
import { app } from "/scripts/app.js";

const EXT_NAME = "comfyui-gallery-loader";
const SAFEVIEW_WARM_URL = "/gallery_loader/safeview_warm";

/** The output arrays worth warming. See the header for why `audio` is absent. */
const MEDIA_KEYS = ["images", "video"] as const;

interface WarmItem {
  type: string;
  subfolder: string;
  name: string;
}

/** One entry of an `executed` output array — every field optional, per zResultItem. */
interface ResultItemish {
  filename?: string;
  subfolder?: string;
  type?: string;
}

/** The `executed` payload, structurally. `output` is passthrough, so it is loose. */
interface ExecutedDetail {
  output?: Record<string, unknown> | null;
}

/**
 * Pull the addressable files out of one `executed` payload.
 *
 * Module-private on purpose: the suite drives it by dispatching a real
 * `executed` event at `app.api`, where a real one lands — a test that called
 * this directly would prove the parser works while saying nothing about
 * whether anything is listening.
 *
 * An item missing a `filename`, or naming a root the backend's perimeter would
 * refuse, is SKIPPED — never repaired into a plausible-looking address.
 */
function itemsFromExecuted(detail: unknown): WarmItem[] {
  const output = (detail as ExecutedDetail | null)?.output;
  if (!output || typeof output !== "object") return [];
  const out: WarmItem[] = [];
  const seen = new Set<string>();
  for (const key of MEDIA_KEYS) {
    const arr = output[key];
    if (!Array.isArray(arr)) continue;
    for (const raw of arr) {
      const item = raw as ResultItemish | null;
      const filename = item?.filename;
      const type = item?.type;
      if (typeof filename !== "string" || filename === "") continue;
      if (typeof type !== "string" || !SANDBOXED_TYPES.includes(type)) continue;
      const subfolder = typeof item?.subfolder === "string" ? item.subfolder : "";
      const id = `${type}:${subfolder}:${filename}`;
      if (seen.has(id)) continue;
      seen.add(id);
      out.push({ type, subfolder, name: filename });
    }
  }
  return out;
}

async function postWarm(items: WarmItem[]): Promise<void> {
  const res = await fetch(SAFEVIEW_WARM_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ items }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
}

/**
 * Listen for completed executions and warm the prompt cache for their outputs.
 *
 * Returns a teardown. Installed unconditionally at `setup()` and cheap when the
 * tier is off — the setting is read at EVENT time, not at install time, so a
 * user who switches the tier on mid-session is covered without a reload, and one
 * who never switches it on never sends a request.
 */
export function installScanWarm(host?: SafeViewSettingHost | null): () => void {
  const api = (app as unknown as { api?: EventTarget }).api;
  if (!api || typeof api.addEventListener !== "function") return () => {};

  const onExecuted = (event: Event): void => {
    // Read the live setting per event. `matchPrompt` off means the cache is
    // never consulted, so warming it would be work nobody asked for.
    const cfg = host ? readSafeViewConfig(host) : readSafeViewConfig();
    if (!cfg.matchPrompt) return;
    const items = itemsFromExecuted((event as CustomEvent).detail);
    if (items.length === 0) return;
    // Fire and forget: a failed warm costs one "unscanned" verdict the sweep
    // will fix, and must never surface a toast over someone's finished render.
    void postWarm(items).catch((e) => {
      console.warn(`[${EXT_NAME}] ${SAFE_VIEW_SETTINGS.matchPrompt} warm failed`, e);
    });
  };

  api.addEventListener("executed", onExecuted);
  return () => api.removeEventListener("executed", onExecuted);
}
