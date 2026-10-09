// @vitest-environment jsdom
//
// The inline node grid's surfaces #86 §3 listed as untested: switching source
// chips (beyond the output chip #111 needed for the commit contract), the
// `.gl-pathinput` free-text field, and how the grid is mounted on the node.
//
// As in picker-navigation.test.js, assertions read what the grid SENT (the
// parsed /list query) — never a substring of the URL — or what it handed the
// frontend, never its own private state.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { attachGallery } from "../../src/gallery_loader.ts";

const FILES = [{ name: "a.png", ext: ".png", mtime: 1, size: 10, width: 8, height: 8, rating: 0 }];

function stubObserver() {
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
}

function stubFetch() {
  const calls = { list: [] };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url) => {
      const s = String(url);
      if (s.includes("/gallery_loader/list")) {
        calls.list.push(new URL(s, "http://localhost").searchParams);
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          ok: true,
          dirs: [{ name: "sub", mtime: 1 }],
          files: FILES,
          exists: true,
        }),
      };
    }),
  );
  return calls;
}

/** A LiteGraph-ish node that records what addDOMWidget was handed. */
function fakeNode(value = "a.png", { size = [100, 100] } = {}) {
  const widget = { name: "image", value, type: "STRING", options: {} };
  const mounted = [];
  return {
    widgets: [widget],
    size,
    mounted,
    addDOMWidget: (name, type, el, options) => {
      mounted.push({ name, type, el, options });
      document.body.appendChild(el);
      return {};
    },
    setDirtyCanvas: () => {},
    _widget: widget,
  };
}

async function mount(value) {
  const node = fakeNode(value);
  attachGallery(node);
  await vi.waitFor(() => {
    if (!document.querySelector(".gl-card")) throw new Error("grid not rendered");
  });
  return node;
}

/** Wait for a listing request matching `pred`, and for the grid to repaint. */
async function waitForList(calls, pred, what) {
  await vi.waitFor(() => {
    const last = calls.list.at(-1);
    if (!last || !pred(last)) throw new Error(`no listing ${what}`);
    if (document.querySelector(".gl-grid.is-loading")) throw new Error("still loading");
  });
}

const chip = (t) => document.querySelector(`.gl-chip[data-type="${t}"]`);
const activeChip = () => document.querySelector(".gl-chip.is-active")?.dataset.type;
const pathInput = () => document.querySelector(".gl-pathinput");
const status = () => document.querySelector(".gl-status").textContent;
/** Give a request every chance to be issued before asserting it was not. */
const settle = () => new Promise((r) => setTimeout(r, 20));

beforeEach(() => {
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
  localStorage.clear();
});

// ---------------------------------------------------------------------------
// Source chips
// ---------------------------------------------------------------------------

describe("node grid source chips", () => {
  it("lists the new root from its top: the old subfolder does not carry over", async () => {
    stubObserver();
    const calls = stubFetch();
    await mount("sub/a.png [input]");
    expect(calls.list.at(-1).get("subfolder")).toBe("sub");

    chip("temp").click();
    await waitForList(calls, (q) => q.get("type") === "temp", "for temp");
    expect(calls.list.at(-1).get("subfolder")).toBe("");
    expect(activeChip()).toBe("temp");
  });

  it("every sandboxed chip lists its own root", async () => {
    stubObserver();
    const calls = stubFetch();
    await mount("a.png [input]");
    for (const t of ["output", "temp", "input"]) {
      chip(t).click();
      await waitForList(calls, (q) => q.get("type") === t, `for ${t}`);
      expect(activeChip()).toBe(t);
      expect(calls.list.at(-1).has("path")).toBe(false);
    }
  });

  it("shows the path field ONLY on the path chip", async () => {
    stubObserver();
    stubFetch();
    await mount("a.png [input]");
    expect(pathInput().style.display).toBe("none");

    chip("path").click();
    await vi.waitFor(() => {
      if (activeChip() !== "path") throw new Error("path chip not active");
    });
    expect(pathInput().style.display).toBe("");

    chip("output").click();
    await vi.waitFor(() => {
      if (activeChip() !== "output") throw new Error("output chip not active");
    });
    expect(pathInput().style.display).toBe("none");
  });

  it("the path chip with no directory yet asks for one instead of listing", async () => {
    stubObserver();
    const calls = stubFetch();
    await mount("a.png [input]");
    const before = calls.list.length;

    chip("path").click();
    await vi.waitFor(() => {
      if (!status().includes("absolute path")) throw new Error("no prompt");
    });
    await settle();
    expect(status()).toBe("Type an absolute path and press Enter.");
    expect(calls.list.length).toBe(before);
    expect(document.querySelector(".gl-card")).toBeNull();
  });

  it("returning to the path chip keeps the directory it was on", async () => {
    // The chip handler resets the SUBFOLDER for a sandboxed root, and must
    // leave the absolute directory alone: hopping to output and back would
    // otherwise drop the user at the "type a path" prompt.
    stubObserver();
    const calls = stubFetch();
    await mount("/data/renders/a.png");
    expect(calls.list.at(-1).get("path")).toBe("/data/renders");

    chip("output").click();
    await waitForList(calls, (q) => q.get("type") === "output", "for output");
    chip("path").click();
    await waitForList(calls, (q) => q.get("type") === "path", "for path");
    expect(calls.list.at(-1).get("path")).toBe("/data/renders");
    expect(pathInput().value).toBe("/data/renders");
  });
});

// ---------------------------------------------------------------------------
// The free-text absolute-path field
// ---------------------------------------------------------------------------

describe("node grid path field", () => {
  async function onEmptyPathTab() {
    stubObserver();
    const calls = stubFetch();
    const node = await mount("a.png [input]");
    chip("path").click();
    await vi.waitFor(() => {
      if (!status().includes("absolute path")) throw new Error("no prompt");
    });
    calls.node = node;
    return calls;
  }

  function type(value) {
    pathInput().value = value;
  }

  it("Enter commits the typed directory and lists it", async () => {
    const calls = await onEmptyPathTab();
    type("  /mnt/renders  ");
    const ev = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
    pathInput().dispatchEvent(ev);
    await waitForList(calls, (q) => q.get("path") === "/mnt/renders", "for the typed path");
    expect(calls.list.at(-1).get("type")).toBe("path");
    // Enter is consumed, so it cannot also submit or reach the canvas.
    expect(ev.defaultPrevented).toBe(true);
    expect(document.querySelector(".gl-card")).not.toBeNull();
  });

  it("any other key does not commit", async () => {
    const calls = await onEmptyPathTab();
    const before = calls.list.length;
    type("/mnt/renders");
    pathInput().dispatchEvent(new KeyboardEvent("keydown", { key: "s", bubbles: true }));
    await settle();
    expect(calls.list.length).toBe(before);
  });

  it("blur commits too — a tap elsewhere on mobile has no Enter key", async () => {
    const calls = await onEmptyPathTab();
    type("/mnt/elsewhere");
    pathInput().dispatchEvent(new FocusEvent("blur"));
    await waitForList(calls, (q) => q.get("path") === "/mnt/elsewhere", "for the blurred path");
  });

  it("a blur on a sandboxed chip does not re-list or switch to path", async () => {
    stubObserver();
    const calls = stubFetch();
    await mount("a.png [output]");
    const before = calls.list.length;
    pathInput().value = "/mnt/renders";
    pathInput().dispatchEvent(new FocusEvent("blur"));
    await settle();
    expect(calls.list.length).toBe(before);
    expect(activeChip()).toBe("output");
  });

  it("a committed file afterwards is the raw path under the typed directory", async () => {
    const calls = await onEmptyPathTab();
    type("/mnt/renders");
    pathInput().dispatchEvent(new FocusEvent("blur"));
    await waitForList(calls, (q) => q.get("path") === "/mnt/renders", "for the typed path");
    document
      .querySelector(".gl-card.is-file")
      .dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(calls.node._widget.value).toBe("/mnt/renders/a.png");
  });
});

// ---------------------------------------------------------------------------
// Mounting on the node
// ---------------------------------------------------------------------------

describe("node grid mounting", () => {
  it("mounts ONE DOM widget, unserialized, hidden when zoomed out", async () => {
    // hideOnZoom is the frontend's DOMWidgetOptions flag (comfyui-frontend-types
    // index.d.ts: "Whether to render a placeholder rectangle when zoomed out").
    // The teardown it triggers belongs to the frontend and is only observable
    // in a live canvas; what this pack owns is ASKING for it, and that is what
    // is pinned here.
    stubObserver();
    stubFetch();
    const node = await mount("a.png");
    expect(node.mounted).toHaveLength(1);
    const [m] = node.mounted;
    expect(m.name).toBe("gl_gallery");
    expect(m.type).toBe("gallery");
    expect(m.el.classList.contains("gl-root")).toBe(true);
    expect(m.el.querySelector(".gl-grid")).not.toBeNull();
    expect(m.options.hideOnZoom).toBe(true);
    // The grid widget carries no value of its own: the `image` STRING widget
    // is what serializes. A serialized DOM widget would add a phantom entry to
    // widgets_values and shift every later value in a saved workflow.
    expect(m.options.serialize).toBe(false);
    expect(m.options.getMinHeight()).toBe(360);
  });

  it("hides the image widget but keeps its value for serialization", async () => {
    stubObserver();
    stubFetch();
    const node = await mount("sub/a.png [input]");
    const w = node._widget;
    expect(w.hidden).toBe(true);
    expect(w.options.hidden).toBe(true);
    expect(w.computeSize()).toEqual([0, -4]);
    expect(w.value).toBe("sub/a.png [input]");
  });

  it("grows an undersized node to fit the grid, and leaves a larger one alone", async () => {
    stubObserver();
    stubFetch();
    const small = fakeNode("a.png", { size: [100, 100] });
    attachGallery(small);
    expect(small.size).toEqual([360, 460]);

    document.body.innerHTML = "";
    const big = fakeNode("a.png", { size: [800, 900] });
    attachGallery(big);
    expect(big.size).toEqual([800, 900]);
  });

  it("does nothing on a node without an image widget", () => {
    stubObserver();
    stubFetch();
    const node = fakeNode("a.png");
    node.widgets = [{ name: "not_image", value: "x" }];
    attachGallery(node);
    expect(node.mounted).toHaveLength(0);
    expect(document.querySelector(".gl-root")).toBeNull();
  });

  it("keeps canvas gestures out of LiteGraph — pointer events stop at the root", async () => {
    stubObserver();
    stubFetch();
    const node = await mount("a.png");
    const seen = [];
    document.body.addEventListener("pointerdown", () => seen.push("pointerdown"));
    document.body.addEventListener("keydown", () => seen.push("keydown"));
    const grid = node.mounted[0].el.querySelector(".gl-grid");
    grid.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    grid.dispatchEvent(new KeyboardEvent("keydown", { key: "a", bubbles: true }));
    expect(seen).toEqual([]);

    // Control: the same listeners DO see an event from outside the widget, so
    // the empty list above is the root's doing, not a dead listener.
    document.body.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    expect(seen).toEqual(["pointerdown"]);
  });
});
