// @vitest-environment jsdom
//
// The 🙈 "mark sensitive" control — the writable half of Safe View's keyword
// tier. It writes the user's first configured keyword into the file's
// `dc:subject`, which is what makes the mark interoperable with digiKam /
// Lightroom / Windows rather than a private flag this pack alone understands.
//
// WHAT THIS TIER CANNOT ASSERT (browser tier — comfyui-pack-live-smoke):
//   - Whether the button is reachable by a real touch, or lands on top of the
//     ⓘ / 📌 / reveal controls. `elementFromPoint` needs layout; jsdom has none.
//   - That the XMP actually round-trips through another photo manager. That is
//     `tests/test_xmp.py`'s job on the packet, and a human's on the app.
//
// The click tests dispatch on the BUTTON, which is where a real click lands.
// Dispatching on `document` (or on the card) would let a handler bound to the
// button never fire, and "the modal did not close" would then be true by
// construction — with or without the stopPropagation the handler relies on.

import { SAFE_VIEW_SETTINGS } from "@laurigates/comfy-modal-kit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openImagePicker } from "../../src/image-picker.ts";
import { hasSensitiveTag, markSensitiveHTML, tagRequestBody } from "../../src/safe-tag.ts";

const FILES = [
  { name: "holiday.png", ext: ".png", mtime: 5, size: 10, rating: 0, tags: [] },
  { name: "beach.png", ext: ".png", mtime: 4, size: 10, rating: 0, tags: ["portrait", "nsfw"] },
];

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

/** Records every POST so a test can assert the request, not just the repaint. */
function stubFetch(tagResponse = { ok: true, tags: ["nsfw"] }) {
  const posts = [];
  const fn = vi.fn(async (url, init) => {
    const s = String(url);
    if (s.includes("/gallery_loader/tag")) {
      posts.push(JSON.parse(init.body));
      return { ok: true, status: 200, json: async () => tagResponse };
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
    return {
      ok: true,
      status: 200,
      json: async () => ({
        ok: true,
        type: "input",
        subfolder: "",
        dirs: [],
        files: FILES.map((f) => ({ ...f })),
        exists: true,
        truncated: false,
      }),
    };
  });
  vi.stubGlobal("fetch", fn);
  return posts;
}

function fakeWidget(value = "holiday.png") {
  return { name: "image", value, type: "combo", options: { values: [] } };
}
function fakeNode(widget) {
  return { widgets: [widget], comfyClass: "LoadImage", type: "LoadImage", addWidget: () => ({}) };
}

async function openPicker() {
  const widget = fakeWidget();
  await openImagePicker(widget, fakeNode(widget), { kind: "loadimage" });
  await vi.waitFor(() => {
    if (!document.querySelector(".ip-card")) throw new Error("grid not rendered");
  });
  return widget;
}

function closePicker() {
  document.querySelector(".cmp-close")?.click();
}

const fileCard = (name) =>
  [...document.querySelectorAll(".ip-card.is-file")].find((c) => c.dataset.name === name);
const markOf = (card) => card.querySelector(".ip-mark-sensitive");

beforeEach(() => {
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});

afterEach(() => {
  closePicker();
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});

// `sensitiveKeyword` used to be unit-tested here. It moved to the kit in 0.14.0
// (laurigates/comfy-modal-kit#33) precisely because this pack and
// comfyui-image-browser each carried a hand-written copy while writing over the
// same files on disk; the kit's own suite covers the function's contract now.
//
// What is still THIS pack's to pin is that its two surfaces call that function
// rather than a constant of their own. The end-to-end 🙈 cases below assert it
// through the DOM (the button's title names the configured keyword and the tap
// POSTs it), and `tests/mutations.json` carries a mutation that hardcodes the
// keyword at the picker's call site — see "TAGS picker — 🙈 writes a hardcoded
// keyword instead of the one the user configured".

describe("hasSensitiveTag", () => {
  it("matches the keyword case-insensitively", () => {
    expect(hasSensitiveTag({ tags: ["NSFW"] }, "nsfw")).toBe(true);
  });

  it("is EXACT, not the filter's token match", () => {
    // `nsfw art` is hidden by the keyword `nsfw` but does not carry it, so the
    // control must read as unmarked — offering to remove a keyword that is not
    // on the file would do nothing and look broken.
    expect(hasSensitiveTag({ tags: ["nsfw art"] }, "nsfw")).toBe(false);
  });

  it("handles a row from a backend that sends no tags at all", () => {
    expect(hasSensitiveTag({}, "nsfw")).toBe(false);
  });
});

describe("tagRequestBody", () => {
  it("addresses a sandboxed root by type + subfolder", () => {
    expect(
      tagRequestBody(
        { type: "output", subfolder: "a/b", absDir: "/x", name: "f.png" },
        "nsfw",
        true,
      ),
    ).toEqual({ type: "output", subfolder: "a/b", name: "f.png", tag: "nsfw", present: true });
  });

  it("addresses a path picker by its absolute directory", () => {
    expect(
      tagRequestBody({ type: "path", subfolder: "", absDir: "/x/y", name: "f.png" }, "nsfw", false),
    ).toEqual({ type: "path", path: "/x/y", name: "f.png", tag: "nsfw", present: false });
  });
});

describe("markSensitiveHTML", () => {
  it("names the keyword it writes, in both the tooltip and the accessible name", () => {
    // A generic "hide this" would leave the user guessing which word lands in
    // the file — the thing that makes the mark portable to another app.
    // Asserting the WHOLE string is what caught the original label: it quoted
    // the keyword with a straight `"`, which closed the title attribute and
    // truncated the tooltip to `Mark sensitive (`.
    const el = document.createElement("div");
    el.innerHTML = markSensitiveHTML("ip", "nsfw", false);
    const btn = el.firstElementChild;
    expect(btn.title).toBe("Mark sensitive (\u2018nsfw\u2019)");
    expect(btn.getAttribute("aria-label")).toBe("Mark sensitive (\u2018nsfw\u2019)");
    expect(btn.getAttribute("aria-pressed")).toBe("false");
  });

  it("says it will REMOVE the keyword when the file already carries it", () => {
    const el = document.createElement("div");
    el.innerHTML = markSensitiveHTML("ip", "nsfw", true);
    const btn = el.firstElementChild;
    expect(btn.title).toBe("Unmark sensitive (removes \u2018nsfw\u2019)");
    expect(btn.getAttribute("aria-pressed")).toBe("true");
    expect(btn.classList.contains("is-marked")).toBe(true);
  });
});

describe("image picker — the control on a card", () => {
  it("renders on every file card, pressed only where the keyword is present", async () => {
    stubSettings();
    stubFetch();
    await openPicker();
    expect(markOf(fileCard("holiday.png")).getAttribute("aria-pressed")).toBe("false");
    expect(markOf(fileCard("beach.png")).getAttribute("aria-pressed")).toBe("true");
  });

  it("is not offered at all when no keyword is configured", async () => {
    // With an empty list there is nothing the control could write that the
    // user's own filter would match, so it must be absent — not present and
    // inert, which reads as a broken button.
    stubSettings({ [SAFE_VIEW_SETTINGS.keywords]: "" });
    stubFetch();
    await openPicker();
    expect(markOf(fileCard("holiday.png"))).toBe(null);
  });

  it("sits outside the element that gets blurred, so a hidden card can be unmarked", async () => {
    // The blur is applied to the media, and the control lives on `.ip-thumb`.
    // If it ever moved inside, marking a file would blur the only control that
    // unmarks it.
    stubSettings();
    stubFetch();
    await openPicker();
    const card = fileCard("beach.png");
    expect(markOf(card).closest(".cmk-sv-blur")).toBe(null);
    expect(getComputedStyle(markOf(card)).filter).not.toBe("blur(18px)");
  });

  it("posts the keyword and the file's own address", async () => {
    stubSettings();
    const posts = stubFetch();
    await openPicker();
    markOf(fileCard("holiday.png")).click();
    await vi.waitFor(() => {
      if (!posts.length) throw new Error("no tag POST");
    });
    expect(posts[0]).toEqual({
      type: "input",
      subfolder: "",
      name: "holiday.png",
      tag: "nsfw",
      present: true,
    });
  });

  it("posts the user's OWN first keyword, not the packaged default", async () => {
    // Every other case in this file configures `nsfw`, which is ALSO the kit's
    // packaged default (SAFE_VIEW_DEFAULT_KEYWORDS) — so a call site that
    // hardcoded the default would satisfy all of them. This is the case that
    // separates "reads the user's config" from "writes a constant that happens
    // to match": the configured list leads with `private`, and `nsfw` is still
    // in it, so the filter is unchanged and only the WRITTEN word differs.
    stubSettings({ [SAFE_VIEW_SETTINGS.keywords]: "private, nsfw" });
    const posts = stubFetch();
    await openPicker();

    // The control announces the same word it will write.
    expect(markOf(fileCard("holiday.png")).title).toBe("Mark sensitive (‘private’)");

    markOf(fileCard("holiday.png")).click();
    await vi.waitFor(() => {
      if (!posts.length) throw new Error("no tag POST");
    });
    expect(posts[0].tag).toBe("private");
  });

  it("removes the keyword when the file already carries it", async () => {
    stubSettings();
    const posts = stubFetch({ ok: true, tags: ["portrait"] });
    await openPicker();
    markOf(fileCard("beach.png")).click();
    await vi.waitFor(() => {
      if (!posts.length) throw new Error("no tag POST");
    });
    expect(posts[0].present).toBe(false);
  });

  it("does not commit the value or close the modal", async () => {
    // The card's own click handler commits and closes. Without the mark
    // handler's stopPropagation, tapping 🙈 would pick the file.
    stubSettings();
    const posts = stubFetch();
    const widget = await openPicker();
    const before = widget.value;
    markOf(fileCard("beach.png")).click();
    await vi.waitFor(() => {
      if (!posts.length) throw new Error("no tag POST");
    });
    expect(widget.value).toBe(before);
    expect(document.querySelector(".cmp-dialog")).not.toBe(null);
  });

  it("blurs the card it just marked", async () => {
    // Marking a file is exactly the event that should hide it, which is why
    // the repaint goes through a full re-render rather than patching a button.
    stubSettings();
    stubFetch({ ok: true, tags: ["nsfw"] });
    await openPicker();
    markOf(fileCard("holiday.png")).click();
    await vi.waitFor(() => {
      const btn = markOf(fileCard("holiday.png"));
      if (btn.getAttribute("aria-pressed") !== "true") throw new Error("not repainted");
    });
    expect(getComputedStyle(fileCard("holiday.png").querySelector(".ip-thumb img")).filter).toBe(
      "blur(18px)",
    );
  });

  it("repaints from the keywords the server read back, NOT from the request", async () => {
    // The two differ whenever the write did not land the way the tap assumed —
    // another device unmarked the file first, or the writer normalised the
    // keyword away. Painting the optimistic guess would then show a mark the
    // file does not carry, and the next tap would try to REMOVE it.
    stubSettings();
    const posts = stubFetch({ ok: true, tags: [] });
    await openPicker();
    markOf(fileCard("holiday.png")).click();
    await vi.waitFor(() => {
      if (!posts.length) throw new Error("no tag POST");
    });
    await vi.waitFor(() => {
      if (markOf(fileCard("holiday.png")).disabled) throw new Error("still in flight");
    });
    expect(markOf(fileCard("holiday.png")).getAttribute("aria-pressed")).toBe("false");
    expect(
      getComputedStyle(fileCard("holiday.png").querySelector(".ip-thumb img")).filter,
    ).not.toBe("blur(18px)");
  });

  it("leaves the card unmarked and re-enabled when the write fails", async () => {
    stubSettings();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url) => {
        const s = String(url);
        if (s.includes("/gallery_loader/tag")) {
          return { ok: true, status: 200, json: async () => ({ ok: false, error: "nope" }) };
        }
        if (s.includes("/gallery_loader/pins")) {
          return { ok: true, status: 200, json: async () => ({ ok: true, max: 100, pins: [] }) };
        }
        if (s.includes("/gallery_loader/base")) {
          return {
            ok: true,
            status: 200,
            json: async () => ({ ok: true, base_path: "/", input_dir: "", output_dir: "" }),
          };
        }
        return {
          ok: true,
          status: 200,
          json: async () => ({
            ok: true,
            type: "input",
            subfolder: "",
            dirs: [],
            files: FILES.map((f) => ({ ...f })),
            exists: true,
            truncated: false,
          }),
        };
      }),
    );
    await openPicker();
    const btn = markOf(fileCard("holiday.png"));
    btn.click();
    await vi.waitFor(() => {
      if (btn.disabled) throw new Error("still in flight");
    });
    expect(btn.getAttribute("aria-pressed")).toBe("false");
  });
});
