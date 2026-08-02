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
