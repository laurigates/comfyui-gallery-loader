// @vitest-environment jsdom
//
// First DOM coverage for the inline node grid. It had none, which is how its
// lazy-thumb observer came to leak one instance per render while the modal
// picker's equivalent — a near-copy of the same function — was covered.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { attachGallery } from "../../src/gallery_loader.ts";

const FILES = [
  { name: "a.png", ext: ".png", mtime: 3, size: 10, width: 8, height: 8, rating: 0 },
  { name: "clip.mp4", ext: ".mp4", mtime: 2, size: 99, rating: 0 },
  { name: "zzz.png", ext: ".png", mtime: 1, size: 10, width: 8, height: 8, rating: 0 },
];

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
          truncated: false,
        }),
      };
    }),
  );
}

/** Records every observer the grid creates, so leaks are visible. */
function stubObserver() {
  const made = [];
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      constructor(_cb, opts) {
        this.rec = { root: opts?.root, disconnected: false };
        made.push(this.rec);
      }
      observe() {}
      unobserve() {}
      disconnect() {
        this.rec.disconnected = true;
      }
    },
  );
  return made;
}

/** Minimal LiteGraph-ish node carrying the `image` widget the grid takes over. */
function fakeNode() {
  const widget = { name: "image", value: "a.png", type: "STRING", options: {} };
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
    _widget: widget,
  };
}

async function mountGrid() {
  const node = fakeNode();
  attachGallery(node);
  await vi.waitFor(() => {
    if (!document.querySelector(".gl-card")) throw new Error("grid not rendered");
  });
  return node;
}

async function search(q) {
  const input = document.querySelector(".gl-search");
  input.value = q;
  input.dispatchEvent(new Event("input", { bubbles: true }));
  await vi.waitFor(() => {
    if (!document.querySelector(".gl-grid")) throw new Error("no grid");
  });
}

describe("gallery node grid lazy thumbnails", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  it("observes against the grid — which IS the scroller here", async () => {
    // The opposite of the modal picker, whose `.ip-grid` has no overflow clip.
    // `.gl-grid` has `overflow-y: auto`, so rooting on it is correct.
    const made = stubObserver();
    stubFetch();
    await mountGrid();

    expect(made.length).toBeGreaterThan(0);
    for (const o of made) {
      expect(o.root).toBeInstanceOf(HTMLElement);
      expect(o.root.classList.contains("gl-grid")).toBe(true);
    }
  });

  it("disconnects the previous observer on re-render", async () => {
    // The leak: renderGrid runs on every search keystroke, and each abandoned
    // observer still referenced every detached card.
    const made = stubObserver();
    stubFetch();
    await mountGrid();
    expect(made).toHaveLength(1);

    await search("a");
    expect(made.length).toBeGreaterThan(1);
    // Every observer but the newest must be disconnected.
    expect(made.slice(0, -1).every((o) => o.disconnected)).toBe(true);
    expect(made.at(-1).disconnected).toBe(false);
  });

  it("parks every thumbnail on data-src until it intersects", async () => {
    // This surface renders <img> for every file — it has no video cards at
    // all, unlike the modal picker. The observer's video branch is there for
    // parity with the shared helper, not because this grid needs it today.
    stubObserver();
    stubFetch();
    await mountGrid();

    expect(document.querySelectorAll(".gl-card img[data-src]").length).toBe(FILES.length);
    expect(document.querySelectorAll(".gl-card img[src]")).toHaveLength(0);
  });
});

describe("gallery node grid search and sort", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  it("filters fuzzily, not by substring", async () => {
    stubObserver();
    stubFetch();
    await mountGrid();
    await search("clp");

    const names = [...document.querySelectorAll(".gl-card.is-file")].map((c) => c.dataset.name);
    // A plain `.includes()` finds nothing for "clp"; the modal picker already
    // matched it, so the two surfaces disagreed on the same query.
    expect(names).toEqual(["clip.mp4"]);
  });

  it("persists the sort choice under the key the picker also reads", async () => {
    stubObserver();
    stubFetch();
    await mountGrid();

    const sel = document.querySelector(".gl-sort");
    sel.value = "name:asc";
    sel.dispatchEvent(new Event("change", { bubbles: true }));
    expect(localStorage.getItem("comfyui-gallery-loader:sort")).toBe("name:asc");
  });

  it("offers size:asc / pixels:asc, and they survive a round trip", async () => {
    // These two used to exist here but be rejected by the picker's validator,
    // so choosing one here silently reset the picker to Newest.
    stubObserver();
    stubFetch();
    await mountGrid();

    const values = [...document.querySelectorAll(".gl-sort option")].map((o) => o.value);
    expect(values).toContain("size:asc");
    expect(values).toContain("pixels:asc");

    const sel = document.querySelector(".gl-sort");
    sel.value = "pixels:asc";
    sel.dispatchEvent(new Event("change", { bubbles: true }));

    document.body.innerHTML = "";
    await mountGrid();
    expect(document.querySelector(".gl-sort").value).toBe("pixels:asc");
  });
});
