// @vitest-environment jsdom
//
// Safe View wiring in both frontends. The MATCHER itself lives in
// @laurigates/comfy-modal-kit and is tested there; what is tested here is this
// pack's wiring of it — which address each card is matched against, which
// element gets blurred, which labels get blocked out, when the reveal set is
// dropped, and what the listing request carries.
//
// WHAT THIS TIER CANNOT ASSERT (browser tier — comfyui-pack-live-smoke):
//   - Whether 18px of blur actually makes a ~150px thumbnail unreadable. jsdom
//     has no layout and no raster; the blur is a resolved property here, not a
//     picture.
//   - Whether the reveal button is reachable by a real touch, or whether it
//     lands on top of the ⓘ / 📌 controls. `document.elementFromPoint` needs
//     layout, which jsdom does not do.
//   - That the spoiler block visually covers the text it replaces.
//
// THE BLUR IS AN INJECTED CLASS RULE, so `el.style.filter` reads "" whether the
// code works or not. Every assertion below goes through getComputedStyle, and
// the first test is a HARNESS CHECK that fails loudly if a jsdom upgrade ever
// stops resolving `filter` — without it the rest of this file would quietly
// stop testing anything while staying green.

import {
  ensureSafeViewStyle,
  notifySafeViewChange,
  SAFE_VIEW_BLUR_CLASS,
  SAFE_VIEW_SETTINGS,
  SAFE_VIEW_SPOILER_CLASS,
} from "@laurigates/comfy-modal-kit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { attachGallery } from "../../src/gallery_loader.ts";
import { openImagePicker } from "../../src/image-picker.ts";

const BLURRED = "blur(18px)";

/** A corpus with matching AND non-matching entries — the controls are the point. */
const FILES = [
  { name: "holiday.png", ext: ".png", mtime: 5, size: 10, width: 8, height: 8, rating: 0 },
  { name: "my_nsfw_pic.png", ext: ".png", mtime: 4, size: 10, width: 8, height: 8, rating: 0 },
  // `nsfw` is a PREFIX of `nsfwish` — a substring matcher hides this one too.
  { name: "nsfwish.png", ext: ".png", mtime: 3, size: 10, width: 8, height: 8, rating: 0 },
  // `ass` is a substring of `classic` — same trap, other direction.
  { name: "classic.png", ext: ".png", mtime: 2, size: 10, width: 8, height: 8, rating: 0 },
];

const DIRS = [
  { name: "sub", mtime: 9 },
  { name: "nsfw", mtime: 8 },
  { name: "assets", mtime: 7 },
];

/**
 * A ComfyUI setting store, which is where the kit reads the live config from
 * (`globalThis.app.extensionManager.setting`). Both gallery packs register the
 * same ids on purpose, so this is the shared surface.
 */
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

function stubFetch(files = FILES, dirs = DIRS) {
  const fn = vi.fn(async (url) => {
    const s = String(url);
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
    return {
      ok: true,
      status: 200,
      json: async () => ({
        ok: true,
        type: "input",
        subfolder: "",
        dirs,
        files,
        exists: true,
        truncated: false,
      }),
    };
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}

function fakeWidget(value = "holiday.png") {
  return { name: "image", value, type: "combo", options: { values: [] } };
}
function fakeNode(widget) {
  return { widgets: [widget], comfyClass: "LoadImage", type: "LoadImage", addWidget: () => ({}) };
}

async function openPicker(value) {
  const widget = fakeWidget(value);
  await openImagePicker(widget, fakeNode(widget), { kind: "loadimage" });
  await vi.waitFor(() => {
    if (!document.querySelector(".ip-card")) throw new Error("grid not rendered");
  });
  return widget;
}

/** Closes through the shell's own control, so onClose actually runs. */
function closePicker() {
  const btn = document.querySelector(".cmp-close");
  if (btn) btn.click();
}

const fileCard = (name) =>
  [...document.querySelectorAll(".ip-card.is-file")].find((c) => c.dataset.name === name);
const dirCard = (name) =>
  [...document.querySelectorAll(".ip-card.is-dir")].find((c) => c.dataset.name === name);

const imgOf = (card) => card.querySelector(".ip-thumb img");
const isBlurred = (card) => getComputedStyle(imgOf(card)).filter === BLURRED;
const revealOf = (card) => card.querySelector(".cmk-sv-reveal");

beforeEach(() => {
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});

afterEach(() => {
  // Every picker must be closed, not just detached: onClose is what disposes
  // the Safe View subscription, and a surviving listener from an earlier test
  // would repaint (and re-fetch) during a later one.
  closePicker();
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});

describe("harness", () => {
  it("jsdom resolves `filter` from an injected class rule", () => {
    // If this goes red, every blur assertion in this file has silently stopped
    // testing anything and they must move to a stylesheet-source scan instead.
    ensureSafeViewStyle();
    const el = document.createElement("div");
    document.body.appendChild(el);
    expect(getComputedStyle(el).filter).not.toBe(BLURRED);
    el.classList.add(SAFE_VIEW_BLUR_CLASS);
    expect(getComputedStyle(el).filter).toBe(BLURRED);
  });
});

describe("image picker — blurring a matched card", () => {
  beforeEach(() => {
    stubSettings();
    stubFetch();
  });

  it("blurs the matching card and leaves the others alone", async () => {
    await openPicker();
    expect(isBlurred(fileCard("my_nsfw_pic.png"))).toBe(true);
    expect(isBlurred(fileCard("holiday.png"))).toBe(false);
  });

  it("blurs the image, NOT the thumbnail container", async () => {
    // `filter` blurs an element's whole subtree. Blurring `.ip-thumb` would
    // smear the ⓘ / 📌 overlay buttons and the reveal button that live inside
    // it — the controls the user needs in order to act on a hidden card.
    await openPicker();
    const card = fileCard("my_nsfw_pic.png");
    expect(getComputedStyle(imgOf(card)).filter).toBe(BLURRED);
    expect(getComputedStyle(card.querySelector(".ip-thumb")).filter).not.toBe(BLURRED);
  });

  it("keeps the reveal button OUT of the blurred subtree", async () => {
    // Containment, not a count: a reveal button nested inside the blurred
    // element renders blurred itself, which is exactly the bug that "blur the
    // whole thumb" produces and which no count would catch.
    await openPicker();
    const card = fileCard("my_nsfw_pic.png");
    const btn = revealOf(card);
    expect(btn).not.toBeNull();
    expect(imgOf(card).contains(btn)).toBe(false);
  });

  it("gives an unmatched card no reveal button", async () => {
    await openPicker();
    expect(revealOf(fileCard("holiday.png"))).toBeNull();
  });

  it("blocks out the name AND removes its title attribute", async () => {
    // The title is the leak that a paint-only spoiler misses: a native tooltip
    // renders the full name on hover regardless of any CSS on the element.
    await openPicker();
    const nameEl = fileCard("my_nsfw_pic.png").querySelector(".ip-name");
    expect(nameEl.classList.contains(SAFE_VIEW_SPOILER_CLASS)).toBe(true);
    // ABSENT, not empty — an empty title still suppresses nothing meaningful
    // and would mean the attribute path was never exercised.
    expect(nameEl.hasAttribute("title")).toBe(false);
  });

  it("leaves an unmatched card's name and title intact", async () => {
    await openPicker();
    const nameEl = fileCard("holiday.png").querySelector(".ip-name");
    expect(nameEl.classList.contains(SAFE_VIEW_SPOILER_CLASS)).toBe(false);
    expect(nameEl.getAttribute("title")).toContain("holiday.png");
  });

  it("does not put the file name in the reveal button's accessible name", async () => {
    // A spoiler that blocks the visible text while announcing the same string
    // to a screen reader has hidden nothing.
    await openPicker();
    const btn = revealOf(fileCard("my_nsfw_pic.png"));
    expect(btn.getAttribute("aria-label")).not.toContain("nsfw");
  });
});

describe("image picker — whole-token matching (controls)", () => {
  it("does not blur a file whose token the keyword merely prefixes", async () => {
    stubSettings();
    stubFetch();
    await openPicker();
    // The positive case is asserted alongside on purpose: a filter that blurred
    // nothing at all would satisfy the negative half by itself.
    expect(isBlurred(fileCard("my_nsfw_pic.png"))).toBe(true);
    expect(isBlurred(fileCard("nsfwish.png"))).toBe(false);
  });

  it("does not blur `classic.png` for the keyword `ass`", async () => {
    stubSettings({ [SAFE_VIEW_SETTINGS.keywords]: "ass" });
    stubFetch();
    await openPicker();
    expect(isBlurred(fileCard("classic.png"))).toBe(false);
  });

  it("does not blur files under `assets/` for the keyword `ass`", async () => {
    // The folder is in the matched address, so a substring matcher hides this
    // whole directory. Opening at `assets/…` puts it in state.subfolder.
    stubSettings({ [SAFE_VIEW_SETTINGS.keywords]: "ass" });
    stubFetch();
    await openPicker("assets/holiday.png");
    expect(isBlurred(fileCard("holiday.png"))).toBe(false);
    expect(isBlurred(fileCard("my_nsfw_pic.png"))).toBe(false);
  });

  it("does not blur the `assets` folder card for the keyword `ass`", async () => {
    stubSettings({ [SAFE_VIEW_SETTINGS.keywords]: "ass" });
    stubFetch();
    await openPicker();
    expect(dirCard("assets").classList.contains("is-safe-hidden")).toBe(false);
  });
});

describe("image picker — the matched address", () => {
  it("includes the ROOT segment, so a keyword naming the tab matches", async () => {
    // The frontend builds `${root}/${subfolder}` and the backend builds
    // type_name + subfolder. Dropping the root here would silently disagree
    // with the server about every file under a matching root.
    stubSettings({ [SAFE_VIEW_SETTINGS.keywords]: "input" });
    stubFetch();
    await openPicker();
    expect(isBlurred(fileCard("holiday.png"))).toBe(true);
    expect(isBlurred(fileCard("classic.png"))).toBe(true);
  });

  it("includes the subfolder segments", async () => {
    stubSettings({ [SAFE_VIEW_SETTINGS.keywords]: "private" });
    stubFetch();
    await openPicker("private/holiday.png");
    expect(isBlurred(fileCard("holiday.png"))).toBe(true);
  });
});

describe("image picker — folder cards", () => {
  beforeEach(() => {
    stubSettings();
    stubFetch();
  });

  it("blocks out a matching folder's name", async () => {
    await openPicker();
    const card = dirCard("nsfw");
    expect(card.classList.contains("is-safe-hidden")).toBe(true);
    const nameEl = card.querySelector(".ip-name");
    expect(nameEl.classList.contains(SAFE_VIEW_SPOILER_CLASS)).toBe(true);
    expect(nameEl.hasAttribute("title")).toBe(false);
  });

  it("leaves a non-matching folder alone", async () => {
    await openPicker();
    expect(dirCard("sub").classList.contains("is-safe-hidden")).toBe(false);
  });
});

describe("image picker — reveal", () => {
  beforeEach(() => {
    stubSettings();
    stubFetch();
  });

  it("unblurs the card and restores its title when tapped", async () => {
    await openPicker();
    // Dispatched on the button inside the card — where a real tap lands — not
    // on document, which would never reach the card's own listener.
    revealOf(fileCard("my_nsfw_pic.png")).click();
    await vi.waitFor(() => {
      if (revealOf(fileCard("my_nsfw_pic.png"))) throw new Error("still hidden");
    });
    const card = fileCard("my_nsfw_pic.png");
    expect(isBlurred(card)).toBe(false);
    const nameEl = card.querySelector(".ip-name");
    expect(nameEl.classList.contains(SAFE_VIEW_SPOILER_CLASS)).toBe(false);
    expect(nameEl.getAttribute("title")).toContain("my_nsfw_pic.png");
  });

  it("reveals only the card that was tapped", async () => {
    stubSettings({ [SAFE_VIEW_SETTINGS.keywords]: "input" });
    await openPicker();
    revealOf(fileCard("holiday.png")).click();
    await vi.waitFor(() => {
      if (revealOf(fileCard("holiday.png"))) throw new Error("still hidden");
    });
    expect(isBlurred(fileCard("holiday.png"))).toBe(false);
    expect(isBlurred(fileCard("classic.png"))).toBe(true);
  });

  it("forgets reveals after navigating to another folder and back", async () => {
    await openPicker();
    revealOf(fileCard("my_nsfw_pic.png")).click();
    await vi.waitFor(() => {
      if (revealOf(fileCard("my_nsfw_pic.png"))) throw new Error("still hidden");
    });
    dirCard("sub").click();
    await vi.waitFor(() => {
      if (!document.querySelector(".ip-card.is-up")) throw new Error("did not descend");
    });
    document.querySelector(".ip-card.is-up").click();
    await vi.waitFor(() => {
      if (document.querySelector(".ip-card.is-up")) throw new Error("did not ascend");
    });
    expect(isBlurred(fileCard("my_nsfw_pic.png"))).toBe(true);
  });
});

describe("image picker — the listing request", () => {
  it("sends no Safe View params while hiding is off", async () => {
    stubSettings();
    const fetchFn = stubFetch();
    await openPicker();
    const listCalls = fetchFn.mock.calls
      .map((c) => String(c[0]))
      .filter((u) => u.includes("/gallery_loader/list"));
    expect(listCalls.length).toBeGreaterThan(0);
    for (const u of listCalls) {
      expect(u).not.toContain("safe_kw");
      expect(u).not.toContain("safe_hide");
    }
  });

  it("sends them once hiding is on", async () => {
    stubSettings({ [SAFE_VIEW_SETTINGS.hide]: true });
    const fetchFn = stubFetch();
    await openPicker();
    const listCalls = fetchFn.mock.calls
      .map((c) => String(c[0]))
      .filter((u) => u.includes("/gallery_loader/list"));
    expect(listCalls.some((u) => u.includes("safe_kw=nsfw"))).toBe(true);
    expect(listCalls.some((u) => u.includes("safe_hide=1"))).toBe(true);
  });

  it("sends nothing when the keyword list is empty, even with hiding on", async () => {
    stubSettings({ [SAFE_VIEW_SETTINGS.hide]: true, [SAFE_VIEW_SETTINGS.keywords]: "" });
    const fetchFn = stubFetch();
    await openPicker();
    for (const u of fetchFn.mock.calls.map((c) => String(c[0]))) {
      expect(u).not.toContain("safe_kw");
    }
  });
});

describe("image picker — the change subscription", () => {
  it("repaints an open picker when the shared setting changes", async () => {
    const values = stubSettings({ [SAFE_VIEW_SETTINGS.keywords]: "zzz" });
    stubFetch();
    await openPicker();
    expect(isBlurred(fileCard("my_nsfw_pic.png"))).toBe(false);
    values[SAFE_VIEW_SETTINGS.keywords] = "nsfw";
    notifySafeViewChange();
    await vi.waitFor(() => {
      if (!isBlurred(fileCard("my_nsfw_pic.png"))) throw new Error("not repainted");
    });
  });

  it("stops listening once the picker closes", async () => {
    // Nothing scheduled may outlive the modal. A surviving listener repaints a
    // detached grid for the rest of the session — and, once hiding is on,
    // re-fetches the listing every time the setting changes.
    const values = stubSettings({ [SAFE_VIEW_SETTINGS.hide]: true });
    const fetchFn = stubFetch();
    await openPicker();
    closePicker();
    const before = fetchFn.mock.calls.length;
    values[SAFE_VIEW_SETTINGS.keywords] = "something-else";
    notifySafeViewChange();
    await new Promise((r) => setTimeout(r, 0));
    expect(fetchFn.mock.calls.length).toBe(before);
  });
});

// ---------------------------------------------------------------------------
// The inline node grid — same filter, its own DOM.
// ---------------------------------------------------------------------------

function fakeGalleryNode() {
  const widget = { name: "image", value: "holiday.png", type: "STRING", options: {} };
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

describe("inline node grid", () => {
  beforeEach(() => {
    stubSettings();
    stubFetch();
  });

  it("blurs a matching card's image and blocks out its name", async () => {
    // The kit's stylesheet is injected by setBlurred/setSpoilered themselves,
    // so this resolves through the same cascade as the picker's — the pack's
    // own gallery_loader.css is a <link> jsdom does not fetch, which is why
    // nothing here asserts a `.gl-*` rule.
    await openGallery();
    const card = glCard("my_nsfw_pic.png");
    expect(getComputedStyle(card.querySelector(".gl-thumb img")).filter).toBe(BLURRED);
    const nameEl = card.querySelector(".gl-name");
    expect(nameEl.classList.contains(SAFE_VIEW_SPOILER_CLASS)).toBe(true);
    expect(nameEl.hasAttribute("title")).toBe(false);
  });

  it("leaves a non-matching card alone", async () => {
    await openGallery();
    const card = glCard("holiday.png");
    expect(getComputedStyle(card.querySelector(".gl-thumb img")).filter).not.toBe(BLURRED);
    expect(card.querySelector(".cmk-sv-reveal")).toBeNull();
  });

  it("does not blur a file whose token the keyword merely prefixes", async () => {
    await openGallery();
    expect(getComputedStyle(glCard("nsfwish.png").querySelector(".gl-thumb img")).filter).not.toBe(
      BLURRED,
    );
  });

  it("keeps the reveal button out of the blurred subtree", async () => {
    await openGallery();
    const card = glCard("my_nsfw_pic.png");
    const btn = card.querySelector(".cmk-sv-reveal");
    expect(btn).not.toBeNull();
    expect(card.querySelector(".gl-thumb img").contains(btn)).toBe(false);
  });

  it("unblurs one card when its reveal is tapped", async () => {
    await openGallery();
    glCard("my_nsfw_pic.png").querySelector(".cmk-sv-reveal").click();
    await vi.waitFor(() => {
      if (glCard("my_nsfw_pic.png").querySelector(".cmk-sv-reveal")) {
        throw new Error("still hidden");
      }
    });
    expect(
      getComputedStyle(glCard("my_nsfw_pic.png").querySelector(".gl-thumb img")).filter,
    ).not.toBe(BLURRED);
  });
});
