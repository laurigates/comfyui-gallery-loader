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
