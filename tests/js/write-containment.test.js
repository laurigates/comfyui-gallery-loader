// @vitest-environment jsdom
//
// The metadata WRITE endpoints (/rating, /tag) are contained to
// input/output/temp — a `type: "path"` address is refused at the resolver's
// first statement (gallery_loader.py, and tests/test_write_containment.py).
// Both frontends therefore have to stop offering the controls that drive them
// in path mode, or the VHS path browser ships a star row and a 🙈 whose every
// press is a 400 with an optimistic repaint in front of it.
//
// Every assertion here is two-sided ON THE SAME CORPUS: the sandboxed arm must
// SHOW the control the path arm hides. A one-sided "no stars in path mode"
// passes just as happily against a grid that renders no stars anywhere, which
// is exactly the regression it would be written to catch.
//
// WHAT THIS TIER CANNOT ASSERT (browser tier — comfyui-pack-live-smoke):
//   - that the card's remaining controls stay reachable once the star row is
//     gone; jsdom performs no layout.

import { SAFE_VIEW_SETTINGS } from "@laurigates/comfy-modal-kit";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { attachGallery } from "../../src/gallery_loader.ts";
import { openImagePicker } from "../../src/image-picker.ts";

const FILES = [
  { name: "a.png", ext: ".png", mtime: 3, size: 10, width: 8, height: 8, rating: 0, tags: [] },
  { name: "b.png", ext: ".png", mtime: 2, size: 10, width: 8, height: 8, rating: 0, tags: [] },
];

/** A keyword must be configured or 🙈 is not offered on ANY card. */
function stubSettings() {
  const values = {
    [SAFE_VIEW_SETTINGS.enabled]: false,
    [SAFE_VIEW_SETTINGS.keywords]: "nsfw",
    [SAFE_VIEW_SETTINGS.hide]: false,
    [SAFE_VIEW_SETTINGS.blurNames]: true,
    [SAFE_VIEW_SETTINGS.matchPrompt]: false,
  };
  vi.stubGlobal("app", {
    extensionManager: {
      setting: { get: (id) => values[id], set: (id, v) => (values[id] = v) },
    },
  });
}

function stubFetch(listedType) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url) => {
      const s = String(url);
      if (s.includes("/gallery_loader/base")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            ok: true,
            base_path: "/comfy",
            input_dir: "/comfy/input",
            output_dir: "/comfy/output",
          }),
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
          type: listedType,
          subfolder: "",
          dirs: [],
          files: FILES,
          exists: true,
          truncated: false,
        }),
      };
    }),
  );
}

function stubInertObserver() {
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
}

beforeEach(() => {
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
  stubSettings();
  stubInertObserver();
});

// ---------------------------------------------------------------------------
// Modal picker
// ---------------------------------------------------------------------------

function fakeWidget(value) {
  return { name: "image", value, type: "combo", options: { values: [] } };
}
function fakeNode(widget) {
  return { widgets: [widget], comfyClass: "LoadImage", type: "LoadImage", addWidget: () => ({}) };
}

async function openPicker(opts, value) {
  const widget = fakeWidget(value);
  await openImagePicker(widget, fakeNode(widget), opts);
  await vi.waitFor(() => {
    if (!document.querySelector(".ip-card")) throw new Error("grid not rendered");
  });
}

const pickerCards = () => [...document.querySelectorAll(".ip-card.is-file")];

describe("modal picker — write controls follow the write perimeter", () => {
  it("offers stars and 🙈 in a sandboxed root", async () => {
    stubFetch("input");
    await openPicker({ kind: "loadimage" }, "a.png");

    const cards = pickerCards();
    expect(cards.length).toBe(FILES.length);
    for (const card of cards) {
      expect(card.querySelectorAll(".ip-star").length).toBeGreaterThan(0);
      expect(card.querySelector(".ip-mark-sensitive")).not.toBeNull();
    }
  });

  it("offers neither in path mode, where the write would be refused", async () => {
    stubFetch("path");
    await openPicker({ kind: "vhs-path", mode: "file", extensions: [".png"] }, "/abs/dir/a.png");

    const cards = pickerCards();
    // Same corpus, same count: the cards are still THERE, only the two
    // write-driven controls are gone. A grid that failed to render would
    // satisfy the two assertions below vacuously.
    expect(cards.length).toBe(FILES.length);
    for (const card of cards) {
      expect(card.querySelectorAll(".ip-star").length).toBe(0);
      expect(card.querySelector(".ip-mark-sensitive")).toBeNull();
    }
  });

  it("keeps the READ controls in path mode — the thumbnail and ⓘ", async () => {
    // Reads were never contained: /file, /thumb and /metadata all accept
    // type=path deliberately. Gating them here would be a different, and
    // wrong, change.
    stubFetch("path");
    await openPicker({ kind: "vhs-path", mode: "file", extensions: [".png"] }, "/abs/dir/a.png");

    for (const card of pickerCards()) {
      expect(card.querySelector(".ip-thumb img[data-src]")).not.toBeNull();
      expect(card.querySelector(".ip-info")).not.toBeNull();
    }
  });
});

// ---------------------------------------------------------------------------
// Inline node grid
// ---------------------------------------------------------------------------

function fakeGridNode(initialValue) {
  const widget = { name: "image", value: initialValue, type: "STRING", options: {} };
  return {
    widgets: [widget],
    size: [400, 400],
    addDOMWidget: (_n, _t, el) => {
      document.body.appendChild(el);
      return {};
    },
    setDirtyCanvas: () => {},
    setSize: () => {},
    onResize: null,
  };
}

async function mountGrid(initialValue) {
  attachGallery(fakeGridNode(initialValue));
  await vi.waitFor(() => {
    if (!document.querySelector(".gl-card")) throw new Error("grid not rendered");
  });
}

const gridCards = () => [...document.querySelectorAll(".gl-card.is-file")];

describe("inline node grid — write controls follow the write perimeter", () => {
  it("offers stars and 🙈 in a sandboxed root", async () => {
    stubFetch("input");
    await mountGrid("a.png");

    const cards = gridCards();
    expect(cards.length).toBe(FILES.length);
    for (const card of cards) {
      expect(card.querySelectorAll(".gl-star").length).toBeGreaterThan(0);
      expect(card.querySelector(".gl-mark-sensitive")).not.toBeNull();
    }
  });

  it("offers neither in path mode", async () => {
    stubFetch("path");
    await mountGrid("/abs/dir/a.png");

    const cards = gridCards();
    expect(cards.length).toBe(FILES.length);
    for (const card of cards) {
      expect(card.querySelectorAll(".gl-star").length).toBe(0);
      expect(card.querySelector(".gl-mark-sensitive")).toBeNull();
    }
  });
});
