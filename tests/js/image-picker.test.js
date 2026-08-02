// @vitest-environment jsdom
//
// First DOM coverage for the modal picker. Promoted from the intentional gap in
// docs/trps/regression-gaps-initial-scaffold.md — two of its trigger conditions
// fired at once: the lazy-thumb regression below reached `main` and was only
// found when a user hit it in the sibling pack (condition 1), and that sibling
// (comfyui-image-browser) needed the identical assertion (condition 3).
import { beforeEach, describe, expect, it, vi } from "vitest";
import { openImagePicker } from "../../src/image-picker.ts";

const FILES = [
  { name: "a.png", ext: ".png", mtime: 3, size: 10, width: 8, height: 8, rating: 0 },
  { name: "b.png", ext: ".png", mtime: 2, size: 10, width: 8, height: 8, rating: 0 },
  { name: "clip.mp4", ext: ".mp4", mtime: 1, size: 99, rating: 0 },
];

/** Stub /gallery_loader/{base,list} so the picker can paint a grid. */
function stubFetch() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url) => {
      const s = String(url);
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
          files: FILES,
          exists: true,
        }),
      };
    }),
  );
}

/** Minimal widget/node pair — the picker only reads name/value and addWidget. */
function fakeWidget() {
  return { name: "image", value: "a.png", type: "combo", options: { values: [] } };
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
}

describe("image picker lazy thumbnails", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    vi.unstubAllGlobals();
  });

  // `.ip-grid` has no overflow clip — the scroller is the modal shell's
  // `.cmp-body`. An IntersectionObserver rooted on a non-clipping element uses
  // that element's WHOLE bounding box as the root rectangle, so every card
  // reports as intersecting on the first callback and the "lazy" load fires for
  // the entire listing at once: one /thumb request per file plus a src +
  // preload=metadata on every <video>. On a large output dir that is enough to
  // kill the tab (it did, in the sibling comfyui-image-browser pack).
  //
  // NOTE this is the opposite of gallery_loader.ts, where `.gl-grid` IS the
  // scroll container and rooting on the grid is correct.
  it("observes against the scroll container, not the grid", async () => {
    const roots = [];
    vi.stubGlobal(
      "IntersectionObserver",
      class {
        constructor(_cb, opts) {
          roots.push(opts?.root);
        }
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
    stubFetch();
    await openPicker();

    expect(roots.length).toBeGreaterThan(0);
    for (const root of roots) {
      expect(root).toBeInstanceOf(HTMLElement);
      expect(root.classList.contains("cmp-body")).toBe(true);
      expect(root.classList.contains("ip-grid")).toBe(false);
    }
  });

  // The consequence the root fix exists to produce: nothing is fetched until
  // the observer says so. With an observer that never reports an intersection,
  // every thumbnail must stay parked on data-src.
  it("leaves thumbnails unloaded until they intersect", async () => {
    vi.stubGlobal(
      "IntersectionObserver",
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
    stubFetch();
    await openPicker();

    expect(document.querySelectorAll(".ip-card img[src], .ip-card video[src]").length).toBe(0);
    expect(
      document.querySelectorAll(".ip-card img[data-src], .ip-card video[data-src]").length,
    ).toBeGreaterThan(0);
    // A parked <video> must also still be preload=none — flipping it to
    // metadata is what makes a wall of clips expensive.
    for (const v of document.querySelectorAll(".ip-card video[data-src]")) {
      expect(v.preload).toBe("none");
    }
  });
});

// ---------------------------------------------------------------------------
// Flat (recursive) view
// ---------------------------------------------------------------------------

// Two files share a NAME across different subpaths. That is the whole reason
// this suite exists: flat view is the first thing in this pack that can show
// them side by side, and every handler used to address files by bare name.
const FLAT_FILES = [
  { name: "x.png", ext: ".png", mtime: 3, size: 10, rating: 0, subpath: "a/b" },
  { name: "x.png", ext: ".png", mtime: 2, size: 10, rating: 0, subpath: "c" },
  { name: "top.png", ext: ".png", mtime: 1, size: 10, rating: 0, subpath: "" },
];

/** Records every request, and serves a flat listing when recursive=1. */
function stubFetchRecording(opts = {}) {
  const calls = { list: [], posts: [] };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url, init) => {
      const s = String(url);
      if (s.includes("/gallery_loader/base")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ ok: true, base_path: "/", input_dir: "", output_dir: "" }),
        };
      }
      if (s.includes("/gallery_loader/rating")) {
        const body = JSON.parse(init.body);
        calls.posts.push(body);
        return { ok: true, status: 200, json: async () => ({ ok: true, rating: body.rating }) };
      }
      calls.list.push(s);
      const recursive = s.includes("recursive=1");
      return {
        ok: true,
        status: 200,
        json: async () => ({
          ok: true,
          type: "input",
          subfolder: "",
          dirs: recursive ? [] : [{ name: "a", mtime: 1 }],
          files: recursive ? FLAT_FILES : FILES,
          exists: true,
          truncated: recursive ? !!opts.truncated : false,
        }),
      };
    }),
  );
  return calls;
}

/** Never intersects, so thumbnails stay parked on data-src for inspection. */
function stubInertObserver() {
  const roots = [];
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      constructor(_cb, o) {
        roots.push(o?.root);
      }
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  return roots;
}

async function openWith({ value = "a.png", kind = "loadimage", mode } = {}) {
  const widget = fakeWidget();
  widget.value = value;
  const node = fakeNode(widget);
  await openImagePicker(widget, node, mode ? { kind, mode } : { kind });
  await vi.waitFor(() => {
    if (!document.querySelector(".ip-card")) throw new Error("grid not rendered");
  });
  return widget;
}

/** Flip into flat view via the real toolbar control and wait for the re-fetch. */
async function goFlat() {
  document.querySelector(".ip-view-toggle").click();
  await vi.waitFor(() => {
    if (!document.querySelector(".ip-card.is-flat")) throw new Error("flat grid not rendered");
  });
}

const VIEW_KEY = "comfyui-gallery-loader:view";
const PENDING_KEY = "comfyui-gallery-loader:view-pending";

describe("image picker flat (recursive) view", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  it("sends recursive=1 only once flat is on", async () => {
    stubInertObserver();
    const calls = stubFetchRecording();
    await openWith();
    expect(calls.list.at(-1)).not.toContain("recursive=1");

    await goFlat();
    expect(calls.list.at(-1)).toContain("recursive=1");
    expect(localStorage.getItem(VIEW_KEY)).toBe("flat");
  });

  it("labels each card with its subpath, and data-sub is the JOINED subfolder", async () => {
    // Opened inside `run/`, so the label the user reads ("a/b") and the address
    // a tap navigates to ("run/a/b") differ. A test written from the root
    // cannot tell the two apart, which is exactly how this gets shipped wrong.
    stubInertObserver();
    stubFetchRecording();
    await openWith({ value: "run/a.png" });
    await goFlat();

    const label = document.querySelector(".ip-subpath[data-sub]");
    expect(label.textContent).toBe("a/b");
    expect(label.dataset.sub).toBe("run/a/b");
  });

  it("renders an inert root marker for top-level files", async () => {
    stubInertObserver();
    stubFetchRecording();
    await openWith();
    await goFlat();

    const root = document.querySelector(".ip-subpath.is-root");
    expect(root).not.toBeNull();
    expect(root.tagName).toBe("DIV"); // not a button — nothing to navigate to
    expect(root.dataset.sub).toBeUndefined();
  });

  it("commits the file's own nested path, unchanged value contract", async () => {
    stubInertObserver();
    stubFetchRecording();
    const widget = await openWith({ value: "output-seed.png" });
    // Switch to the output tab so the annotated form applies.
    document.querySelector('.ip-tab[data-type="output"]').click();
    await vi.waitFor(() => {
      if (!document.querySelector(".ip-card")) throw new Error("no grid");
    });
    await goFlat();

    document.querySelector('.ip-card.is-flat[data-idx="0"] .ip-thumb').click();
    expect(widget.value).toBe("a/b/x.png [output]");
  });

  it("commits bare-relative on input, so input workflows do not churn", async () => {
    stubInertObserver();
    stubFetchRecording();
    const widget = await openWith();
    await goFlat();

    document.querySelector('.ip-card.is-flat[data-idx="0"] .ip-thumb').click();
    expect(widget.value).toBe("a/b/x.png");
  });

  it("two files with the SAME NAME commit their own folders", async () => {
    // The regression that motivates addressing cards by index. Against any
    // dataset.name-keyed implementation both clicks commit the same path.
    stubInertObserver();
    stubFetchRecording();
    const w1 = await openWith();
    await goFlat();
    document.querySelector('.ip-card.is-flat[data-idx="0"] .ip-thumb').click();
    expect(w1.value).toBe("a/b/x.png");

    document.body.innerHTML = "";
    const w2 = await openWith();
    await vi.waitFor(() => {
      if (!document.querySelector(".ip-card.is-flat")) throw new Error("not flat");
    });
    document.querySelector('.ip-card.is-flat[data-idx="1"] .ip-thumb').click();
    expect(w2.value).toBe("c/x.png");
  });

  it("builds each thumbnail URL from the file's own subfolder", async () => {
    stubInertObserver();
    stubFetchRecording();
    await openWith();
    await goFlat();

    const imgs = [...document.querySelectorAll(".ip-card.is-flat img[data-src]")];
    expect(imgs[0].dataset.src).toContain("subfolder=a%2Fb");
    expect(imgs[1].dataset.src).toContain("subfolder=c");
  });

  it("rates the clicked file, not the first one sharing its name", async () => {
    // Fails against `state.files.find(x => x.name === name)`: that rates the
    // a/b copy no matter which star row was clicked, and the optimistic
    // repaint makes the wrong write look successful.
    stubInertObserver();
    const calls = stubFetchRecording();
    await openWith();
    await goFlat();

    const secondCard = document.querySelector('.ip-card.is-flat[data-idx="1"]');
    secondCard.querySelector('.ip-star[data-val="4"]').click();
    await vi.waitFor(() => {
      if (!calls.posts.length) throw new Error("no rating posted");
    });
    expect(calls.posts[0]).toMatchObject({ subfolder: "c", name: "x.png", rating: 4 });
  });

  it("tapping a subpath label drops back to folder view there", async () => {
    stubInertObserver();
    const calls = stubFetchRecording();
    await openWith();
    await goFlat();

    document.querySelector(".ip-subpath[data-sub]").click();
    await vi.waitFor(() => {
      if (calls.list.at(-1).includes("recursive=1")) throw new Error("still flat");
    });
    expect(calls.list.at(-1)).toContain("subfolder=a%2Fb");
    expect(localStorage.getItem(VIEW_KEY)).toBe("folder");
  });

  it("warns when the listing was truncated", async () => {
    stubInertObserver();
    stubFetchRecording({ truncated: true });
    await openWith();
    await goFlat();

    await vi.waitFor(() => {
      if (!document.querySelector("#cmn-notify-container")) throw new Error("no toast");
    });
    expect(document.querySelector("#cmn-notify-container").textContent).toContain("newest");
  });

  it("recovers to folder view when the previous flat load never finished", async () => {
    // The tab died mid-flat-load, so the sentinel is still set. Honouring the
    // stored preference would reopen straight into the same failure with no
    // way to reach the toggle.
    localStorage.setItem(VIEW_KEY, "flat");
    localStorage.setItem(PENDING_KEY, "1");
    stubInertObserver();
    const calls = stubFetchRecording();
    await openWith();

    expect(calls.list[0]).not.toContain("recursive=1");
    expect(localStorage.getItem(PENDING_KEY)).toBeNull();
    expect(localStorage.getItem(VIEW_KEY)).toBe("folder");
    await vi.waitFor(() => {
      if (!document.querySelector("#cmn-notify-container")) throw new Error("no toast");
    });
    expect(document.querySelector("#cmn-notify-container").textContent).toContain("folder view");
  });

  it("clears the pending sentinel once the grid has painted", async () => {
    stubInertObserver();
    stubFetchRecording();
    await openWith();
    await goFlat();
    expect(localStorage.getItem(PENDING_KEY)).toBeNull();
  });

  it("hides the toggle on the path tab and omits it in directory mode", async () => {
    stubInertObserver();
    stubFetchRecording();
    await openWith({ kind: "vhs-path", mode: "directory" });
    // Not created at all — a hidden-but-present control is a dead control.
    expect(document.querySelector(".ip-view-toggle")).toBeNull();

    document.body.innerHTML = "";
    vi.unstubAllGlobals();
    stubInertObserver();
    stubFetchRecording();
    await openWith({ kind: "vhs-path", value: "/abs/dir/f.png" });
    expect(document.querySelector(".ip-view-toggle")).toBeNull();
  });

  it("still observes against the scroll container in flat view", async () => {
    // Flat is the scale at which a wrong root stops being survivable.
    const roots = stubInertObserver();
    stubFetchRecording();
    await openWith();
    await goFlat();

    expect(roots.length).toBeGreaterThan(0);
    for (const root of roots) {
      expect(root.classList.contains("cmp-body")).toBe(true);
      expect(root.classList.contains("ip-grid")).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// Pinned folders + match highlighting
// ---------------------------------------------------------------------------

const PINS_KEY = "comfyui-gallery-loader:pins";

describe("image picker pinned folders", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  it("pins the current folder and reflects it on the toggle", async () => {
    stubInertObserver();
    stubFetchRecording();
    await openWith({ value: "run/a.png" });

    document.querySelector(".ip-pin-toggle").click();
    expect(JSON.parse(localStorage.getItem(PINS_KEY))).toEqual([
      { type: "input", subfolder: "run" },
    ]);
    expect(document.querySelector(".ip-pin-toggle").classList.contains("is-active")).toBe(true);
    expect(document.querySelector(".ip-pin-go").textContent).toBe("📌 input/run");
  });

  it("toggling again unpins", async () => {
    stubInertObserver();
    stubFetchRecording();
    await openWith({ value: "run/a.png" });

    const toggle = document.querySelector(".ip-pin-toggle");
    toggle.click();
    toggle.click();
    expect(JSON.parse(localStorage.getItem(PINS_KEY))).toEqual([]);
    expect(document.querySelectorAll(".ip-pin-chip")).toHaveLength(0);
  });

  it("tapping a chip navigates there", async () => {
    localStorage.setItem(PINS_KEY, JSON.stringify([{ type: "output", subfolder: "keep" }]));
    stubInertObserver();
    const calls = stubFetchRecording();
    await openWith();

    document.querySelector(".ip-pin-go").click();
    await vi.waitFor(() => {
      if (!calls.list.at(-1).includes("subfolder=keep")) throw new Error("not navigated");
    });
    expect(calls.list.at(-1)).toContain("type=output");
  });

  it("the ✕ unpins without navigating", async () => {
    localStorage.setItem(PINS_KEY, JSON.stringify([{ type: "output", subfolder: "keep" }]));
    stubInertObserver();
    const calls = stubFetchRecording();
    await openWith();
    const before = calls.list.length;

    document.querySelector(".ip-pin-x").click();
    expect(JSON.parse(localStorage.getItem(PINS_KEY))).toEqual([]);
    expect(calls.list.length).toBe(before);
  });

  it("drops persisted pins that name a non-sandboxed root", async () => {
    // Pins address write-ish targets; a `path` pin has no stable meaning and
    // would send type=path with a subfolder the backend cannot resolve.
    localStorage.setItem(
      PINS_KEY,
      JSON.stringify([
        { type: "path", subfolder: "/etc" },
        { type: "temp", subfolder: "" },
      ]),
    );
    stubInertObserver();
    stubFetchRecording();
    await openWith();

    const labels = [...document.querySelectorAll(".ip-pin-go")].map((b) => b.textContent);
    expect(labels).toEqual(["📌 temp"]);
  });

  it("survives corrupt stored pins", async () => {
    localStorage.setItem(PINS_KEY, "{not json");
    stubInertObserver();
    stubFetchRecording();
    await expect(openWith()).resolves.toBeTruthy();
    expect(document.querySelectorAll(".ip-pin-chip")).toHaveLength(0);
  });

  it("omits the pin control for a path picker", async () => {
    stubInertObserver();
    stubFetchRecording();
    await openWith({ kind: "vhs-path", value: "/abs/dir/f.png" });
    expect(document.querySelector(".ip-pin-toggle")).toBeNull();
  });
});

describe("image picker match highlighting", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  async function typeQuery(q) {
    const input = document.querySelector(".cmp-search, input");
    input.value = q;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await vi.waitFor(() => {
      if (!document.querySelector(".ip-card.is-file")) throw new Error("no cards");
    });
  }

  it("wraps the matched characters of a filename", async () => {
    stubInertObserver();
    stubFetchRecording();
    await openWith();
    await typeQuery("clip");

    const marks = document.querySelectorAll(".ip-name .cmp-match");
    expect(marks.length).toBeGreaterThan(0);
    expect([...marks].map((m) => m.textContent).join("")).toBe("clip");
    // The full filename is still readable, not replaced by the match.
    expect(document.querySelector(".ip-card.is-file .ip-name").textContent).toBe("clip.mp4");
  });

  it("offsets indices so a subpath match never highlights the wrong characters", async () => {
    // In flat view the haystack is "subpath/name" but the highlight is painted
    // on the name element alone. Query "a" matches only via the a/b subpath —
    // "x.png" has no "a" at all — so the name must carry NO marks. With
    // unshifted indices, index 0 (the subpath's "a") marks the name's first
    // character instead, highlighting an "x" the user never searched for.
    stubInertObserver();
    stubFetchRecording();
    await openWith();
    await goFlat();
    await typeQuery("a");

    const cards = document.querySelectorAll(".ip-card.is-file");
    expect(cards).toHaveLength(1); // only a/b/x.png matches
    const name = cards[0].querySelector(".ip-name");
    expect(name.textContent).toBe("x.png");
    expect(name.querySelectorAll(".cmp-match")).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Metadata overlay
// ---------------------------------------------------------------------------

/** Extends the recording stub with a /metadata reply. */
function stubFetchWithMeta(meta, { fail = false } = {}) {
  const calls = { meta: [] };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url) => {
      const s = String(url);
      if (s.includes("/gallery_loader/metadata")) {
        calls.meta.push(s);
        if (fail) return { ok: false, status: 500, json: async () => ({ ok: false }) };
        return { ok: true, status: 200, json: async () => ({ ok: true, ...meta }) };
      }
      if (s.includes("/gallery_loader/base")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ ok: true, base_path: "/", input_dir: "", output_dir: "" }),
        };
      }
      const recursive = s.includes("recursive=1");
      return {
        ok: true,
        status: 200,
        json: async () => ({
          ok: true,
          type: "input",
          subfolder: "",
          dirs: [],
          files: recursive ? FLAT_FILES : FILES,
          exists: true,
          truncated: false,
        }),
      };
    }),
  );
  return calls;
}

const FULL_META = {
  format: "png",
  source: "a1111",
  summary: { positive: "a cat", negative: "blurry", seed: "42" },
  raw: { parameters: "a cat\nNegative prompt: blurry" },
  truncated: false,
};

async function openInfo(idx = 0) {
  document.querySelectorAll(".ip-card.is-file")[idx].querySelector(".ip-info").click();
  await vi.waitFor(() => {
    if (!document.querySelector(".ip-meta-src")) throw new Error("overlay not filled");
  });
}

describe("image picker metadata overlay", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  it("shows ⓘ on images but not on video cards", async () => {
    stubInertObserver();
    stubFetchWithMeta(FULL_META);
    await openWith();

    const cards = [...document.querySelectorAll(".ip-card.is-file")];
    const byName = Object.fromEntries(cards.map((c) => [c.dataset.name, c]));
    expect(byName["a.png"].querySelector(".ip-info")).not.toBeNull();
    // /metadata is IMG_EXTS-gated, so a video card must not offer the control.
    expect(byName["clip.mp4"].querySelector(".ip-info")).toBeNull();
  });

  it("renders ⓘ on a path picker too — it is a read, not a write", async () => {
    stubInertObserver();
    stubFetchWithMeta(FULL_META);
    await openWith({ kind: "vhs-path", value: "/abs/dir/f.png" });
    expect(document.querySelector(".ip-card.is-file .ip-info")).not.toBeNull();
  });

  it("paints a status line immediately, before the read resolves", async () => {
    stubInertObserver();
    stubFetchWithMeta(FULL_META);
    await openWith();
    // No await — the overlay must exist synchronously on click, or a big file
    // on a slow disk makes the button feel dead.
    document.querySelector(".ip-card.is-file .ip-info").click();
    expect(document.querySelector(".ip-meta-status")).not.toBeNull();
  });

  it("lists recognised fields in a fixed order with per-row copy", async () => {
    stubInertObserver();
    stubFetchWithMeta(FULL_META);
    await openWith();
    await openInfo();

    const labels = [...document.querySelectorAll(".ip-meta-k")].map((k) => k.textContent);
    // META_FIELDS order, not the response's key order.
    expect(labels).toEqual(["Positive", "Negative", "Seed"]);
    expect(document.querySelectorAll("[data-copy-row]")).toHaveLength(3);
    expect(document.querySelector(".ip-meta-src").textContent).toContain("A1111");
    expect(document.querySelector("[data-copy-all]")).not.toBeNull();
  });

  it("never invents a row for an empty or whitespace value", async () => {
    stubInertObserver();
    stubFetchWithMeta({
      ...FULL_META,
      summary: { positive: "a cat", negative: "   ", seed: null },
    });
    await openWith();
    await openInfo();

    const labels = [...document.querySelectorAll(".ip-meta-k")].map((k) => k.textContent);
    expect(labels).toEqual(["Positive"]);
  });

  it("distinguishes no embedded text from unmapped text", async () => {
    stubInertObserver();
    stubFetchWithMeta({ format: "png", source: "none", summary: {}, raw: {}, truncated: false });
    await openWith();
    await openInfo();
    expect(document.querySelector(".ip-meta-empty").textContent).toContain(
      "No generation metadata found",
    );
    expect(document.querySelector(".ip-meta-raw")).toBeNull();

    document.body.innerHTML = "";
    vi.unstubAllGlobals();
    stubInertObserver();
    stubFetchWithMeta({
      format: "png",
      source: "none",
      summary: {},
      raw: { Software: "some tool" },
      truncated: false,
    });
    await openWith();
    await openInfo();
    expect(document.querySelector(".ip-meta-empty").textContent).toContain(
      "No recognised generation parameters",
    );
    // The raw disclosure IS the answer in this case, so it must be there.
    expect(document.querySelector(".ip-meta-raw")).not.toBeNull();
    expect(document.querySelector(".ip-meta-raw summary").textContent).toContain("1 key");
  });

  it("notes a server-side truncation", async () => {
    stubInertObserver();
    stubFetchWithMeta({ ...FULL_META, truncated: true });
    await openWith();
    await openInfo();
    expect(document.querySelector(".ip-meta-note")).not.toBeNull();
  });

  it("addresses the clicked file's own subfolder in flat view", async () => {
    stubInertObserver();
    const calls = stubFetchWithMeta(FULL_META);
    await openWith();
    await goFlat();
    await openInfo(1); // the c/x.png copy

    expect(calls.meta[0]).toContain("subfolder=c");
    expect(calls.meta[0]).toContain("name=x.png");
  });

  it("closes the overlay first, then reports a read failure", async () => {
    // The toast stack is a body-level child above the dialog, so its ✕ would
    // land on the overlay's own controls if the overlay were still open.
    stubInertObserver();
    stubFetchWithMeta(FULL_META, { fail: true });
    await openWith();
    document.querySelector(".ip-card.is-file .ip-info").click();

    await vi.waitFor(() => {
      if (!document.querySelector("#cmn-notify-container")) throw new Error("no toast");
    });
    expect(document.querySelector(".ip-meta-card")).toBeNull();
    expect(document.querySelector("#cmn-notify-container").textContent).toContain("Metadata");
  });

  it("keeps the picker open — the overlay is in-dialog", async () => {
    // A second openModalShell would dismiss the picker under single-modal
    // discipline; openShellOverlay is what avoids that.
    stubInertObserver();
    stubFetchWithMeta(FULL_META);
    await openWith();
    await openInfo();
    expect(document.querySelector(".ip-grid")).not.toBeNull();
    expect(document.querySelectorAll(".cmp-dialog")).toHaveLength(1);
  });

  it("does not commit the file when ⓘ is clicked", async () => {
    stubInertObserver();
    stubFetchWithMeta(FULL_META);
    const widget = await openWith();
    const before = widget.value;
    await openInfo();
    expect(widget.value).toBe(before);
  });
});

// ---------------------------------------------------------------------------
// Android / gesture back
// ---------------------------------------------------------------------------

const popBack = () => window.dispatchEvent(new PopStateEvent("popstate"));

describe("image picker back button", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  it("ascends one directory instead of leaving ComfyUI", async () => {
    stubInertObserver();
    const calls = stubFetchRecording();
    await openWith({ value: "run/deep/a.png" });

    // Compare the parsed param, not a substring: "subfolder=run" is a prefix
    // of "subfolder=run%2Fdeep", so a substring test passes before the ascend.
    const subOf = (u) => new URL(u, "http://localhost").searchParams.get("subfolder");
    expect(subOf(calls.list.at(-1))).toBe("run/deep");
    popBack();
    await vi.waitFor(() => {
      if (subOf(calls.list.at(-1)) !== "run") throw new Error("did not ascend");
    });
    // Still open — back acted on the picker, not on history.
    expect(document.querySelector(".ip-grid")).not.toBeNull();
  });

  it("closes the picker at a root", async () => {
    stubInertObserver();
    stubFetchRecording();
    await openWith({ value: "a.png" }); // no subfolder — already at the root

    popBack();
    await vi.waitFor(() => {
      if (document.querySelector(".ip-grid")) throw new Error("still open");
    });
  });

  it("dismisses an open overlay first, leaving the picker up", async () => {
    stubInertObserver();
    stubFetchWithMeta(FULL_META);
    await openWith({ value: "a.png" });
    await openInfo();
    expect(document.querySelector(".ip-meta-card")).not.toBeNull();

    popBack();
    await vi.waitFor(() => {
      if (document.querySelector(".ip-meta-card")) throw new Error("overlay still up");
    });
    // One back = one dismissal: the picker itself survives.
    expect(document.querySelector(".ip-grid")).not.toBeNull();
  });

  it("does not commit a value on back", async () => {
    stubInertObserver();
    stubFetchRecording();
    const widget = await openWith({ value: "a.png" });
    const before = widget.value;
    popBack();
    await vi.waitFor(() => {
      if (document.querySelector(".ip-grid")) throw new Error("still open");
    });
    expect(widget.value).toBe(before);
  });
});
