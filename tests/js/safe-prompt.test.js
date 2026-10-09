// @vitest-environment jsdom
//
// Safe View's opt-in PROMPT tier, wired into both frontends — the modal picker
// and the inline node grid — plus the `executed` cache warmer. A PORT of
// comfyui-image-browser's tests (that pack's PR #83), adapted to this pack's
// two surfaces: one surface honouring the tier and the other not is exactly the
// split-brain the port exists to close, so each is asserted separately.
//
// WHAT THIS TIER CAN ASSERT HERE. The verdict arrives as a field on the listing
// row, so jsdom sees the whole decision path: request flag -> response field ->
// isSensitive -> the resolved blur class. What it CANNOT see is whether the
// backend's cache holds the right text — that is tests/test_safe_prompt.py,
// driven against real embedded metadata.
//
// THE FOUR STATES ARE THE POINT. `true` and `false` are the easy half. The two
// that matter are `"unscanned"` (participates, no verdict yet -> blurred,
// fail-safe) and ABSENT (outside the tier -> never blurred). Collapsing them in
// either direction is a shipped bug, so every assertion below carries both
// directions in the same listing.

import { SAFE_VIEW_SETTINGS } from "@laurigates/comfy-modal-kit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { app } from "/scripts/app.js";
import { attachGallery } from "../../src/gallery_loader.ts";
import { openImagePicker } from "../../src/image-picker.ts";
import { installScanWarm } from "../../src/scan-warm.ts";

const BLURRED = "blur(18px)";
const PNG = { ext: ".png", mtime: 2, size: 10, width: 8, height: 8, rating: 0 };

// Innocent names, innocent folder: nothing but the verdict can blur these.
const MATCHED = { name: "holiday_a.png", ...PNG, prompt_match: true };
const CLEAR = { name: "holiday_b.png", ...PNG, prompt_match: false };
const UNSCANNED = { name: "holiday_c.png", ...PNG, prompt_match: "unscanned" };
// No `prompt_match` key at all — a container the backend has no reader for.
const OUTSIDE = { name: "holiday_d.avi", ...PNG, ext: ".avi" };
const ALL = [MATCHED, CLEAR, UNSCANNED, OUTSIDE];

const TIER_ON = {
  [SAFE_VIEW_SETTINGS.keywords]: "nsfw",
  [SAFE_VIEW_SETTINGS.matchPrompt]: true,
};

function stubSettings(overrides = {}) {
  const values = {
    [SAFE_VIEW_SETTINGS.enabled]: true,
    [SAFE_VIEW_SETTINGS.keywords]: "nsfw",
    [SAFE_VIEW_SETTINGS.hide]: false,
    [SAFE_VIEW_SETTINGS.blurNames]: true,
    [SAFE_VIEW_SETTINGS.matchPrompt]: false,
    ...overrides,
  };
  vi.stubGlobal("app", {
    extensionManager: {
      setting: {
        get: (id) => values[id],
        set: (id, v) => {
          values[id] = v;
        },
      },
    },
  });
  return values;
}

/**
 * `listings` maps a subfolder to `{dirs, files, unscanned}`. Every request URL
 * is recorded in `calls`; every POST body in `posts`.
 */
function stubFetch(listings, calls = [], posts = []) {
  const fn = vi.fn(async (url, init) => {
    const s = String(url);
    calls.push(s);
    if (init?.method === "POST") {
      posts.push({ url: s, body: JSON.parse(init.body) });
      return { ok: true, status: 200, json: async () => ({ ok: true, scanned: 0 }) };
    }
    if (s.includes("/gallery_loader/base")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ ok: true, base_path: "/", input_dir: "", output_dir: "" }),
      };
    }
    if (s.includes("/gallery_loader/pins")) {
      return { ok: true, status: 200, json: async () => ({ ok: true, max: 100, pins: [] }) };
    }
    const sub = new URL(s, "http://x").searchParams.get("subfolder") ?? "";
    const entry = listings[sub] ?? { files: [] };
    return {
      ok: true,
      status: 200,
      json: async () => ({
        ok: true,
        type: "input",
        subfolder: sub,
        dirs: entry.dirs ?? [],
        files: entry.files ?? [],
        exists: true,
        truncated: false,
        ...(entry.unscanned === undefined ? {} : { safe_unscanned: entry.unscanned }),
      }),
    };
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}

const listCalls = (calls) => calls.filter((u) => u.includes("/gallery_loader/list"));

// ---- modal picker harness ---------------------------------------------

function fakeWidget(value = "holiday_b.png") {
  return { name: "image", value, type: "combo", options: { values: [] } };
}
function fakeNode(widget) {
  return { widgets: [widget], comfyClass: "LoadImage", type: "LoadImage", addWidget: () => ({}) };
}

async function openPicker() {
  const widget = fakeWidget();
  await openImagePicker(widget, fakeNode(widget), { kind: "loadimage" });
  await vi.waitFor(() => {
    if (!document.querySelector(".ip-card.is-file")) throw new Error("grid not rendered");
  });
}

function closePicker() {
  const btn = document.querySelector(".cmp-close");
  if (btn) btn.click();
}

const fileCard = (name) =>
  [...document.querySelectorAll(".ip-card.is-file")].find((c) => c.dataset.name === name);
const isBlurred = (card) => {
  const media = card.querySelector(".ip-thumb img, .ip-thumb video, .ip-thumb > .ip-thumb-icon");
  return media ? getComputedStyle(media).filter === BLURRED : false;
};
const pill = () => document.querySelector(".ip-scan-pill");

// ---- inline grid harness ----------------------------------------------

function fakeGalleryNode() {
  const widget = { name: "image", value: "holiday_b.png", type: "STRING", options: {} };
  return {
    widgets: [widget],
    size: [400, 400],
    addDOMWidget: (_n, _t, el) => {
      document.body.appendChild(el);
      return {};
    },
    setDirtyCanvas: () => {},
    setSize: () => {},
  };
}

async function openGallery() {
  attachGallery(fakeGalleryNode());
  await vi.waitFor(() => {
    if (!document.querySelector(".gl-card.is-file")) throw new Error("grid not rendered");
  });
}

const glCard = (name) =>
  [...document.querySelectorAll(".gl-card.is-file")].find((c) => c.dataset.name === name);
const glBlurred = (card) => {
  const img = card.querySelector(".gl-thumb img");
  return img ? getComputedStyle(img).filter === BLURRED : false;
};

beforeEach(() => {
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});

afterEach(() => {
  closePicker();
  document.body.innerHTML = "";
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// Modal picker
// ---------------------------------------------------------------------------

describe("image picker — the prompt tier's four states", () => {
  it("blurs a file whose cached prompt matched, on an innocent name and path", async () => {
    stubSettings(TIER_ON);
    stubFetch({ "": { files: ALL } });
    await openPicker();
    expect(isBlurred(fileCard("holiday_a.png"))).toBe(true);
    // Paired negative, same listing: a tier that blurred everything would
    // satisfy the positive on its own.
    expect(isBlurred(fileCard("holiday_b.png"))).toBe(false);
  });

  it("COLD CACHE: `unscanned` is blurred — the fail-safe reading of an unknown", async () => {
    stubSettings(TIER_ON);
    stubFetch({ "": { files: ALL } });
    await openPicker();
    expect(isBlurred(fileCard("holiday_c.png"))).toBe(true);
    expect(isBlurred(fileCard("holiday_b.png"))).toBe(false);
  });

  it("CONTROL: a row with NO verdict is never blurred by this tier", async () => {
    // `undefined` means "does not participate", not "not scanned yet".
    // Paired positive: the same listing still blurs the unscanned row, so "the
    // tier is off" cannot satisfy this.
    stubSettings(TIER_ON);
    stubFetch({ "": { files: ALL } });
    await openPicker();
    expect(isBlurred(fileCard("holiday_d.avi"))).toBe(false);
    expect(isBlurred(fileCard("holiday_c.png"))).toBe(true);
  });

  it("CONTROL: a FOLDER card is never blurred by this tier", async () => {
    stubSettings(TIER_ON);
    stubFetch({ "": { dirs: [{ name: "holiday", mtime: 1 }], files: [UNSCANNED] } });
    await openPicker();
    const dir = [...document.querySelectorAll(".ip-card.is-dir")].find(
      (c) => c.dataset.name === "holiday",
    );
    expect(dir.classList.contains("is-safe-hidden")).toBe(false);
    expect(isBlurred(fileCard("holiday_c.png"))).toBe(true);
  });

  it("consults no verdict while the tier is SWITCHED OFF", async () => {
    // Paired positive: Safe View itself is still on, so the name match must
    // still blur — "nothing is blurred" alone passes against a filter that has
    // been switched off entirely.
    stubSettings({ [SAFE_VIEW_SETTINGS.keywords]: "nsfw" });
    stubFetch({ "": { files: [...ALL, { name: "my_nsfw_pic.png", ...PNG }] } });
    await openPicker();
    expect(isBlurred(fileCard("holiday_c.png"))).toBe(false);
    expect(isBlurred(fileCard("holiday_a.png"))).toBe(false);
    expect(isBlurred(fileCard("my_nsfw_pic.png"))).toBe(true);
  });
});

describe("image picker — the listing request", () => {
  it("asks for the tier only when it is on AND there are keywords", async () => {
    const calls = [];
    stubSettings(TIER_ON);
    stubFetch({ "": { files: ALL } }, calls);
    await openPicker();
    const lists = listCalls(calls);
    expect(lists.some((u) => u.includes("safe_prompt=1") && u.includes("safe_kw=nsfw"))).toBe(true);
    // Independent of hiding: blur-only is this tier's default mode.
    expect(lists.some((u) => u.includes("safe_hide"))).toBe(false);
  });

  it("does NOT ask for the tier when it is off (the default URL is unchanged)", async () => {
    const calls = [];
    stubSettings({ [SAFE_VIEW_SETTINGS.keywords]: "nsfw" });
    stubFetch({ "": { files: ALL } }, calls);
    await openPicker();
    expect(listCalls(calls).length).toBeGreaterThan(0);
    expect(calls.some((u) => u.includes("safe_prompt") || u.includes("safe_kw"))).toBe(false);
  });

  it("does NOT ask for the tier with an empty keyword list", async () => {
    const calls = [];
    stubSettings({ [SAFE_VIEW_SETTINGS.keywords]: "", [SAFE_VIEW_SETTINGS.matchPrompt]: true });
    stubFetch({ "": { files: ALL } }, calls);
    await openPicker();
    expect(listCalls(calls).length).toBeGreaterThan(0);
    expect(calls.some((u) => u.includes("safe_prompt"))).toBe(false);
  });

  it("RE-FETCHES when the tier is switched on, rather than repainting stale rows", async () => {
    // Rows fetched with the tier off carry no verdicts, so a repaint alone
    // could never blur a prompt match. Both directions: the first listing must
    // NOT have asked, the one after the switch must.
    const calls = [];
    const values = stubSettings({ [SAFE_VIEW_SETTINGS.keywords]: "nsfw" });
    stubFetch({ "": { files: ALL } }, calls);
    await openPicker();
    expect(listCalls(calls).some((u) => u.includes("safe_prompt"))).toBe(false);
    values[SAFE_VIEW_SETTINGS.matchPrompt] = true;
    const { notifySafeViewChange } = await import("@laurigates/comfy-modal-kit");
    notifySafeViewChange();
    await vi.waitFor(() => {
      if (!listCalls(calls).some((u) => u.includes("safe_prompt=1"))) {
        throw new Error("not re-fetched");
      }
    });
  });
});

describe("image picker — the scanning pill", () => {
  const FILES = [{ name: "holiday.png", ...PNG, prompt_match: "unscanned" }];

  it("reports the count, then hides once the listing is fully scanned", async () => {
    // ONE test, both directions, driven by a real navigation: asserting only
    // that it appears passes against an always-visible pill, and only that it
    // hides against one that never shows.
    stubSettings(TIER_ON);
    stubFetch({
      "": { dirs: [{ name: "done", mtime: 1 }], files: FILES, unscanned: 7 },
      done: { files: [{ name: "scanned.png", ...PNG, prompt_match: false }], unscanned: 0 },
    });
    await openPicker();
    expect(pill().style.display).not.toBe("none");
    expect(pill().textContent).toContain("7");

    [...document.querySelectorAll(".ip-card.is-dir")]
      .find((c) => c.dataset.name === "done")
      .click();
    await vi.waitFor(() => {
      if (!fileCard("scanned.png")) throw new Error("subfolder not rendered");
    });
    expect(pill().style.display).toBe("none");
  });

  it("stays hidden when the tier is off, however the response is shaped", async () => {
    stubSettings({ [SAFE_VIEW_SETTINGS.keywords]: "nsfw" });
    stubFetch({ "": { files: FILES, unscanned: 4 } });
    await openPicker();
    expect(pill().style.display).toBe("none");
  });

  it("polls while the count is non-zero, and stops when the picker closes", async () => {
    // A timer that outlives the modal re-lists a dead grid every few seconds
    // forever. Both halves: the poll must FIRE while open (or "no fetch after
    // close" passes against a poll that never existed), and must not after.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const calls = [];
    stubSettings(TIER_ON);
    stubFetch({ "": { files: FILES, unscanned: 3 } }, calls);
    await openPicker();
    const before = listCalls(calls).length;
    await vi.advanceTimersByTimeAsync(3500);
    expect(listCalls(calls).length).toBeGreaterThan(before);

    closePicker();
    const afterClose = listCalls(calls).length;
    await vi.advanceTimersByTimeAsync(10000);
    expect(listCalls(calls).length).toBe(afterClose);
  });

  it("the poll is BOUNDED per location — a stalled sweep does not poll forever", async () => {
    // Re-arming the budget per LOAD rather than per location would make it
    // unbounded: each poll is a load, so it would top up what it just spent.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const calls = [];
    stubSettings(TIER_ON);
    stubFetch({ "": { files: FILES, unscanned: 3 } }, calls);
    await openPicker();
    const before = listCalls(calls).length;
    await vi.advanceTimersByTimeAsync(3000 * 30);
    const polled = listCalls(calls).length - before;
    expect(polled).toBeGreaterThan(0);
    expect(polled).toBeLessThanOrEqual(20);
    // The pill still says what it knows: a stalled scan stays visible.
    expect(pill().style.display).not.toBe("none");
  });

  it("does not poll once the count is zero", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const calls = [];
    stubSettings(TIER_ON);
    stubFetch({ "": { files: [CLEAR], unscanned: 0 } }, calls);
    await openPicker();
    const before = listCalls(calls).length;
    await vi.advanceTimersByTimeAsync(10000);
    expect(listCalls(calls).length).toBe(before);
  });
});

// ---------------------------------------------------------------------------
// Inline node grid — the second call site
// ---------------------------------------------------------------------------

describe("inline node grid — the prompt tier", () => {
  it("blurs a matched and an unscanned file, and leaves the clear and the absent alone", async () => {
    stubSettings(TIER_ON);
    stubFetch({ "": { files: ALL } });
    await openGallery();
    expect(glBlurred(glCard("holiday_a.png"))).toBe(true);
    expect(glBlurred(glCard("holiday_c.png"))).toBe(true);
    expect(glBlurred(glCard("holiday_b.png"))).toBe(false);
    expect(glBlurred(glCard("holiday_d.avi"))).toBe(false);
  });

  it("asks for the tier only when it is on", async () => {
    const on = [];
    stubSettings(TIER_ON);
    stubFetch({ "": { files: ALL } }, on);
    await openGallery();
    expect(listCalls(on).some((u) => u.includes("safe_prompt=1"))).toBe(true);

    document.body.innerHTML = "";
    vi.unstubAllGlobals();
    const off = [];
    stubSettings({ [SAFE_VIEW_SETTINGS.keywords]: "nsfw" });
    stubFetch({ "": { files: ALL } }, off);
    await openGallery();
    expect(listCalls(off).length).toBeGreaterThan(0);
    expect(off.some((u) => u.includes("safe_prompt"))).toBe(false);
  });

  it("reports the unscanned count in the status line", async () => {
    stubSettings(TIER_ON);
    stubFetch({ "": { files: ALL, unscanned: 5 } });
    await openGallery();
    const status = document.querySelector(".gl-status");
    expect(status.textContent).toContain("scanning 5");
  });

  it("says nothing about scanning when the count is zero", async () => {
    stubSettings(TIER_ON);
    stubFetch({ "": { files: [CLEAR], unscanned: 0 } });
    await openGallery();
    const status = document.querySelector(".gl-status");
    // Paired positive: the status line was written at all.
    expect(status.textContent).toContain("img");
    expect(status.textContent).not.toContain("scanning");
  });
});

// ---------------------------------------------------------------------------
// The `executed` cache warmer
// ---------------------------------------------------------------------------

describe("the executed cache warmer", () => {
  let uninstall = null;

  beforeEach(() => {
    // `app` is the MODULE the warmer imported (the /scripts/app.js mock), not
    // the global stubSettings owns. A fresh bus per test, so a listener from
    // an earlier test cannot post into a later one.
    app.api = new EventTarget();
  });

  afterEach(() => {
    uninstall?.();
    uninstall = null;
  });

  function fireExecuted(output) {
    app.api.dispatchEvent(
      new CustomEvent("executed", { detail: { node: "9", prompt_id: "p", output } }),
    );
  }

  async function firstPost(posts) {
    await vi.waitFor(() => {
      if (posts.length === 0) throw new Error("no warm posted");
    });
    return posts[0];
  }

  it("posts the images AND the videos a render produced", async () => {
    const posts = [];
    stubSettings(TIER_ON);
    stubFetch({}, [], posts);
    uninstall = installScanWarm();
    fireExecuted({
      images: [{ filename: "a.png", subfolder: "d", type: "output" }],
      video: [{ filename: "b.mp4", subfolder: "", type: "output" }],
    });
    const post = await firstPost(posts);
    expect(post.url).toContain("/gallery_loader/safeview_warm");
    expect(post.body.items).toEqual([
      { type: "output", subfolder: "d", name: "a.png" },
      { type: "output", subfolder: "", name: "b.mp4" },
    ]);
  });

  it("SKIPS an item with no filename, or an unsandboxed root, rather than posting it", async () => {
    const posts = [];
    stubSettings(TIER_ON);
    stubFetch({}, [], posts);
    uninstall = installScanWarm();
    fireExecuted({
      images: [
        { subfolder: "d", type: "output" },
        { filename: "x.png", type: "path" },
        { filename: "real.png", type: "output" },
      ],
    });
    const post = await firstPost(posts);
    expect(post.body.items).toEqual([{ type: "output", subfolder: "", name: "real.png" }]);
  });

  it("does not post AUDIO, while still posting the image beside it", async () => {
    const posts = [];
    stubSettings(TIER_ON);
    stubFetch({}, [], posts);
    uninstall = installScanWarm();
    fireExecuted({
      audio: [{ filename: "a.flac", type: "output" }],
      images: [{ filename: "b.png", type: "output" }],
    });
    const post = await firstPost(posts);
    expect(post.body.items).toEqual([{ type: "output", subfolder: "", name: "b.png" }]);
  });

  it("posts nothing while the tier is off, and starts the moment it is on", async () => {
    const posts = [];
    const values = stubSettings({ [SAFE_VIEW_SETTINGS.keywords]: "nsfw" });
    stubFetch({}, [], posts);
    uninstall = installScanWarm();
    fireExecuted({ images: [{ filename: "a.png", type: "output" }] });
    await new Promise((r) => setTimeout(r, 0));
    expect(posts).toEqual([]);

    values[SAFE_VIEW_SETTINGS.matchPrompt] = true;
    fireExecuted({ images: [{ filename: "b.png", type: "output" }] });
    const post = await firstPost(posts);
    expect(post.body.items).toEqual([{ type: "output", subfolder: "", name: "b.png" }]);
  });

  it("stops listening after teardown", async () => {
    // Fire once BEFORE tearing down, or "no posts after teardown" is satisfied
    // by a listener that was never installed.
    const posts = [];
    stubSettings(TIER_ON);
    stubFetch({}, [], posts);
    const stop = installScanWarm();
    fireExecuted({ images: [{ filename: "a.png", type: "output" }] });
    await firstPost(posts);
    stop();
    fireExecuted({ images: [{ filename: "b.png", type: "output" }] });
    await new Promise((r) => setTimeout(r, 0));
    expect(posts).toHaveLength(1);
  });

  it("is installed by the picker extension's setup()", async () => {
    const { extensionNamed } = await import("/scripts/app.js");
    const ext = extensionNamed("comfy.gallery-loader.image-picker");
    expect(ext).toBeDefined();
    const posts = [];
    stubSettings(TIER_ON);
    stubFetch({}, [], posts);
    ext.setup();
    fireExecuted({ images: [{ filename: "a.png", type: "output" }] });
    const post = await firstPost(posts);
    expect(post.body.items).toEqual([{ type: "output", subfolder: "", name: "a.png" }]);
  });
});
