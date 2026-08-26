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

// Audio became a listable kind with the audio loaders (#117). These cards
// paint a 🎵 glyph instead of an <img>/<video>, which is the ONLY thing that
// differs about them — the write controls are gated on the card's TYPE, never
// on its media kind, so audio must follow the same perimeter as a PNG.
const AUDIO_FILES = [
  { name: "a.flac", ext: ".flac", mtime: 3, size: 10, rating: 0, tags: [] },
  { name: "b.wav", ext: ".wav", mtime: 2, size: 10, rating: 0, tags: [] },
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

function stubFetch(listedType, files = FILES) {
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
          files,
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

  it("keeps the READ controls in path mode — the thumbnail and the name", async () => {
    // The picker's mirror of this test is what stops "hide the write
    // controls" from being implemented as "render a bare card". Without it
    // on THIS surface, the two path-mode assertions above are satisfied by a
    // grid that renders nothing but an empty div, and the inline node grid
    // is the surface that had no commit-contract coverage at all until #111.
    //
    // The grid has no ⓘ button — generation metadata is the picker's control
    // — so its read surface is the lazy thumbnail plus the name, both of
    // which are served by endpoints that accept type=path deliberately.
    stubFetch("path");
    await mountGrid("/abs/dir/a.png");

    const cards = gridCards();
    expect(cards.length).toBe(FILES.length);
    for (const card of cards) {
      expect(card.querySelector(".gl-thumb img[data-src]")).not.toBeNull();
      expect(card.querySelector(".gl-name")?.textContent).toBeTruthy();
    }
  });
});

// ---------------------------------------------------------------------------
// Audio cards are ordinary cards
// ---------------------------------------------------------------------------
//
// #117 widened the picker to the audio loaders, and the write perimeter landed
// in the same release train. The risk this block pins is a NEW kind slipping
// past the gate — an audio branch in the thumb renderer that reintroduces the
// star row for its own cards, or a widened MEDIA_EXTS that reaches the write
// endpoints without the type gate coming with it.
//
// Both arms assert the 🎵 glyph is present, so "no stars" can never be
// satisfied by a card that failed to render at all.

describe("modal picker — audio cards follow the same write perimeter", () => {
  it("offers stars and 🙈 on an audio card in a sandboxed root", async () => {
    stubFetch("input", AUDIO_FILES);
    await openPicker({ kind: "loadimage" }, "a.flac");

    const cards = pickerCards();
    expect(cards.length).toBe(AUDIO_FILES.length);
    for (const card of cards) {
      expect(card.querySelector(".ip-thumb-icon.is-audio")).not.toBeNull();
      expect(card.querySelectorAll(".ip-star").length).toBeGreaterThan(0);
      expect(card.querySelector(".ip-mark-sensitive")).not.toBeNull();
    }
  });

  it("offers neither on an audio card in path mode", async () => {
    stubFetch("path", AUDIO_FILES);
    await openPicker(
      { kind: "vhs-path", mode: "file", extensions: [".flac", ".wav"] },
      "/abs/dir/a.flac",
    );

    const cards = pickerCards();
    expect(cards.length).toBe(AUDIO_FILES.length);
    for (const card of cards) {
      // The card rendered, and it rendered as AUDIO — so the two assertions
      // below are about the perimeter and not about an empty grid.
      expect(card.querySelector(".ip-thumb-icon.is-audio")).not.toBeNull();
      expect(card.querySelectorAll(".ip-star").length).toBe(0);
      expect(card.querySelector(".ip-mark-sensitive")).toBeNull();
    }
  });
});

describe("inline node grid — audio cards follow the same write perimeter", () => {
  it("offers stars and 🙈 on an audio card in a sandboxed root", async () => {
    stubFetch("input", AUDIO_FILES);
    await mountGrid("a.flac");

    const cards = gridCards();
    expect(cards.length).toBe(AUDIO_FILES.length);
    for (const card of cards) {
      expect(card.querySelectorAll(".gl-star").length).toBeGreaterThan(0);
      expect(card.querySelector(".gl-mark-sensitive")).not.toBeNull();
    }
  });

  it("offers neither on an audio card in path mode", async () => {
    stubFetch("path", AUDIO_FILES);
    await mountGrid("/abs/dir/a.flac");

    const cards = gridCards();
    expect(cards.length).toBe(AUDIO_FILES.length);
    for (const card of cards) {
      expect(card.querySelector(".gl-name")?.textContent).toBeTruthy();
      expect(card.querySelectorAll(".gl-star").length).toBe(0);
      expect(card.querySelector(".gl-mark-sensitive")).toBeNull();
    }
  });
});
