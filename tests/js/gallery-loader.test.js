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
function fakeNode(initialValue = "a.png") {
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
    _widget: widget,
  };
}

async function mountGrid(initialValue) {
  const node = fakeNode(initialValue);
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

describe("node grid commit contract", () => {
  // The inline grid and the modal picker commit DIFFERENT strings for the same
  // input-type file, and that is deliberate — see the long note above
  // `buildAnnotated` in src/gallery_loader.ts. Only the picker half was pinned
  // (tests/js/image-picker.test.js › "commits bare-relative on input"); this
  // block pins the other half so neither side can be "unified" into the other
  // without a red test naming the consumer it would break.
  beforeEach(() => {
    document.body.innerHTML = "";
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  async function clickFile(name) {
    const card = [...document.querySelectorAll(".gl-card.is-file")].find(
      (c) => c.dataset.name === name,
    );
    if (!card) throw new Error(`no file card for ${name}`);
    // Dispatched ON the card: the handler is delegated from `.gl-grid`, an
    // ancestor, so a real tap lands here and bubbles up. Dispatching on the
    // grid itself would find no `.closest(".gl-card")` and assert nothing.
    card.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    return card;
  }

  it("annotates input, unlike the modal picker's bare-relative form", async () => {
    // GalleryLoadImage's `image` is a STRING widget with no option list, so
    // there is nothing for a bare value to match and the root is stated
    // outright. `_resolve_input_string` accepts it via get_annotated_filepath.
    stubObserver();
    stubFetch();
    const node = await mountGrid();
    await clickFile("zzz.png");
    expect(node._widget.value).toBe("zzz.png [input]");
  });

  it("annotates output the same way, so the input case is not a hard-wired string", async () => {
    // The paired positive for the assertion above: an implementation that
    // always emitted "[input]" would pass that test and fail this one, and one
    // that never annotated would fail both.
    stubObserver();
    stubFetch();
    const node = await mountGrid();
    document.querySelector('.gl-chip[data-type="output"]').click();
    await vi.waitFor(() => {
      if (!document.querySelector(".gl-chip.is-active[data-type='output']")) {
        throw new Error("output chip not active");
      }
      if (!document.querySelector(".gl-card.is-file")) throw new Error("no grid");
    });
    await clickFile("zzz.png");
    expect(node._widget.value).toBe("zzz.png [output]");
  });

  it("nests the subfolder INSIDE the annotation, not after it", async () => {
    // "sub/zzz.png [input]", never "zzz.png [input]/sub" or "sub [input]/zzz.png".
    // folder_paths.annotated_filepath strips a fixed 9-char "[output]"-plus-space
    // suffix, so the marker has to be last.
    stubObserver();
    stubFetch();
    const node = await mountGrid("sub/a.png [input]");
    await clickFile("zzz.png");
    expect(node._widget.value).toBe("sub/zzz.png [input]");
  });

  it("reads the picker's bare-relative form back as input and re-emits it annotated", async () => {
    // The bridge that makes the divergence safe: parseAnnotated's bare branch
    // classifies an un-annotated value as input, so a widget seeded with what
    // the modal picker writes lands on the input root with its subfolder
    // intact rather than on whatever tab happens to be first.
    stubObserver();
    stubFetch();
    const node = await mountGrid("sub/a.png");
    expect(document.querySelector(".gl-chip.is-active").dataset.type).toBe("input");
    await clickFile("zzz.png");
    expect(node._widget.value).toBe("sub/zzz.png [input]");
  });

  it("commits a RAW absolute path on the path tab — no annotation at all", async () => {
    // type=path has no sandbox root to name, and VHS path widgets take the
    // raw string. Annotating here would break every path loader.
    stubObserver();
    stubFetch();
    const node = await mountGrid("/data/renders/a.png");
    expect(document.querySelector(".gl-chip.is-active").dataset.type).toBe("path");
    await clickFile("zzz.png");
    expect(node._widget.value).toBe("/data/renders/zzz.png");
  });
});
