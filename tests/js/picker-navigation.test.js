// @vitest-environment jsdom
//
// The picker paths #86 §2 listed as untested: directory mode, VHS path mode,
// and navigation (folder cards, the `..` card, breadcrumbs, tabs).
//
// Some of §2 had already been closed elsewhere by the time this file was
// written, and is deliberately NOT repeated here:
//   - the sandboxed "Use this folder" commit, `.` at a root, the `.__none__`
//     sentinel and descending in directory mode — video-loaders.test.js
//     › "VHS_LoadImages (directory combo)";
//   - ascending through the back button — image-picker.test.js › "image
//     picker back button".
//
// Every assertion here reads what the picker SENT (the parsed /list query) or
// COMMITTED (widget.value), never its own state — and a URL is compared by its
// parsed parameter, never a substring: "subfolder=run" is a prefix of
// "subfolder=run%2Fdeep", so a substring check passes before navigation.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { openImagePicker } from "../../src/image-picker.ts";

const FILES = [
  { name: "a.png", ext: ".png", mtime: 2, size: 10, width: 8, height: 8, rating: 0 },
  { name: "b.png", ext: ".png", mtime: 1, size: 10, width: 8, height: 8, rating: 0 },
];

/** Never intersects, so no thumbnail is fetched and nothing races the asserts. */
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

/**
 * Records every /list request and every /base request. Every folder holds one
 * subfolder `sub` and the two FILES, whatever was asked for — the backend's
 * filtering is not under test, the picker's requests and commits are.
 */
function stubFetch({ basePath = "/srv/comfy" } = {}) {
  const calls = { list: [], base: 0 };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url) => {
      const s = String(url);
      if (s.includes("/gallery_loader/base")) {
        calls.base += 1;
        return {
          ok: true,
          status: 200,
          json: async () => ({ ok: true, base_path: basePath, input_dir: "", output_dir: "" }),
        };
      }
      if (s.includes("/gallery_loader/pins")) {
        return { ok: true, status: 200, json: async () => ({ ok: true, max: 200, pins: [] }) };
      }
      calls.list.push(new URL(s, "http://localhost").searchParams);
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

function fakeWidget(value) {
  return { name: "image", value, type: "combo", options: { values: [] } };
}

function fakeNode(widget) {
  return {
    widgets: [widget],
    comfyClass: "LoadImage",
    type: "LoadImage",
    addWidget: () => ({}),
    setDirtyCanvas: () => {},
  };
}

/**
 * Run a navigation `act`, then wait for the listing it caused to be REPAINTED.
 *
 * Waiting on the request alone is not enough: the fetch resolves before
 * renderGrid runs, so the previous folder's cards are still in the DOM for a
 * tick and an assertion there reads the folder just left. A marker planted in
 * the grid is wiped by renderGrid's `innerHTML = ""`, so its absence proves the
 * repaint happened.
 */
async function navigate(calls, act, pred, what) {
  const marker = document.createElement("i");
  marker.className = "stale-grid-marker";
  document.querySelector(".ip-grid").appendChild(marker);
  act();
  await vi.waitFor(() => {
    const last = calls.list.at(-1);
    if (!last || !pred(last)) throw new Error(`no listing ${what}`);
    if (document.querySelector(".stale-grid-marker")) throw new Error("grid not repainted");
    if (!document.querySelector(".ip-card")) throw new Error("grid did not paint");
  });
}

async function open(opts, value = "", picker = openImagePicker) {
  const widget = fakeWidget(value);
  await picker(widget, fakeNode(widget), opts);
  await vi.waitFor(() => {
    if (!document.querySelector(".ip-card")) throw new Error("grid did not paint");
  });
  return widget;
}

/** Click the way a tap lands: on the card's thumbnail, bubbling to the grid. */
function tapCard(card) {
  (card.querySelector(".ip-thumb") ?? card).dispatchEvent(
    new MouseEvent("click", { bubbles: true }),
  );
}

function fileCard(name) {
  const c = [...document.querySelectorAll(".ip-card.is-file")].find((x) => x.dataset.name === name);
  if (!c) throw new Error(`no file card ${name}`);
  return c;
}

function crumb(text) {
  const c = [...document.querySelectorAll(".ip-crumb")].find((x) => x.textContent === text);
  if (!c) throw new Error(`no crumb "${text}"`);
  return c;
}

const pickerOpen = () => document.querySelector(".ip-grid") !== null;

beforeEach(() => {
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
  localStorage.clear();
});

// ---------------------------------------------------------------------------
// Directory mode
// ---------------------------------------------------------------------------

describe("directory mode", () => {
  it("renders file cards inert, and a tap on one neither commits nor closes", async () => {
    stubInertObserver();
    stubFetch();
    const widget = await open({ kind: "loadimage", mode: "directory" }, "frames");

    const card = fileCard("a.png");
    expect(card.classList.contains("is-inert")).toBe(true);
    tapCard(card);
    expect(widget.value).toBe("frames");
    expect(pickerOpen()).toBe(true);
  });

  it("the same card in file mode is live — the paired positive", async () => {
    stubInertObserver();
    stubFetch();
    const widget = await open({ kind: "loadimage" }, "frames/b.png");

    const card = fileCard("a.png");
    expect(card.classList.contains("is-inert")).toBe(false);
    tapCard(card);
    expect(widget.value).toBe("frames/a.png");
    expect(pickerOpen()).toBe(false);
  });

  it("a path picker in directory mode sends the .__none__ sentinel when it has no extensions", async () => {
    stubInertObserver();
    const calls = stubFetch();
    await open({ kind: "vhs-path", mode: "directory" }, "/abs/frames");
    expect(calls.list.at(-1).get("extensions")).toBe(".__none__");
  });

  it("…and a path picker in FILE mode sends no extensions at all (the backend's default)", async () => {
    stubInertObserver();
    const calls = stubFetch();
    await open({ kind: "vhs-path", mode: "file" }, "/abs/frames/a.png");
    expect(calls.list.at(-1).get("extensions")).toBeNull();
  });

  it("a path picker's own extensions win over the sentinel in directory mode", async () => {
    // VHS_LoadImagesPath carries vhs_path_extensions; its folder picker lists
    // those files (inert) rather than nothing.
    stubInertObserver();
    const calls = stubFetch();
    await open({ kind: "vhs-path", mode: "directory", extensions: ["png", ".jpg"] }, "/abs/frames");
    expect(calls.list.at(-1).get("extensions")).toBe(".png,.jpg");
  });

  it("opens a path picker INSIDE the committed folder and 'Use this folder' commits it raw", async () => {
    // In directory mode the widget value IS the folder, so its last segment is
    // the folder to open — not a file name to strip off.
    stubInertObserver();
    const calls = stubFetch();
    const widget = await open({ kind: "vhs-path", mode: "directory" }, "/abs/frames");
    expect(calls.list.at(-1).get("path")).toBe("/abs/frames");

    document.querySelector(".ip-use-folder").click();
    expect(widget.value).toBe("/abs/frames");
    expect(pickerOpen()).toBe(false);
  });

  it("commits a folder descended into, joined onto the absolute path", async () => {
    stubInertObserver();
    const calls = stubFetch();
    const widget = await open({ kind: "vhs-path", mode: "directory" }, "/abs/frames");

    await navigate(
      calls,
      () => tapCard(document.querySelector(".ip-card.is-dir")),
      (q) => q.get("path") === "/abs/frames/sub",
      "for the subfolder",
    );
    expect(document.querySelector(".ip-use-folder").textContent).toBe("Use /abs/frames/sub");
    document.querySelector(".ip-use-folder").click();
    expect(widget.value).toBe("/abs/frames/sub");
  });
});

// ---------------------------------------------------------------------------
// VHS path mode (file)
// ---------------------------------------------------------------------------

describe("VHS path mode", () => {
  it("commits a RAW absolute path for a picked file", async () => {
    stubInertObserver();
    stubFetch();
    const widget = await open({ kind: "vhs-path" }, "/abs/dir/b.png");
    tapCard(fileCard("a.png"));
    expect(widget.value).toBe("/abs/dir/a.png");
    // A path widget has no option list to extend, unlike the LoadImage combo.
    expect(widget.options.values).toEqual([]);
  });

  it("commits the file's path inside a folder it descended into", async () => {
    stubInertObserver();
    const calls = stubFetch();
    const widget = await open({ kind: "vhs-path" }, "/abs/dir/b.png");
    await navigate(
      calls,
      () => tapCard(document.querySelector(".ip-card.is-dir")),
      (q) => q.get("path") === "/abs/dir/sub",
      "for the subfolder",
    );
    tapCard(fileCard("a.png"));
    expect(widget.value).toBe("/abs/dir/sub/a.png");
  });

  // /base is fetched once per page and cached at MODULE level, so whichever
  // test opened an empty path picker first would decide the base for every
  // later one. These two get a fresh module each.
  async function freshPicker() {
    vi.resetModules();
    return (await import("../../src/image-picker.ts")).openImagePicker;
  }

  it("seeds an EMPTY widget from /base and lists the base path", async () => {
    stubInertObserver();
    const calls = stubFetch({ basePath: "/srv/comfy" });
    await open({ kind: "vhs-path" }, "", await freshPicker());
    expect(calls.base).toBeGreaterThan(0);
    expect(calls.list.at(-1).get("type")).toBe("path");
    expect(calls.list.at(-1).get("path")).toBe("/srv/comfy");
  });

  it("a non-empty widget lists its own directory, not the base path", async () => {
    // The paired positive: a picker that always listed /base would pass the
    // test above and fail here.
    stubInertObserver();
    const calls = stubFetch({ basePath: "/srv/comfy" });
    await open({ kind: "vhs-path" }, "/abs/dir/a.png", await freshPicker());
    expect(calls.list.at(-1).get("path")).toBe("/abs/dir");
    expect(calls.base).toBe(0);
  });

  it("falls back to / when /base reports no base path", async () => {
    stubInertObserver();
    const calls = stubFetch({ basePath: "" });
    await open({ kind: "vhs-path" }, "", await freshPicker());
    expect(calls.list.at(-1).get("path")).toBe("/");
  });
});

// ---------------------------------------------------------------------------
// Navigation
// ---------------------------------------------------------------------------

describe("navigation", () => {
  it("a folder card descends on a sandboxed root, joining the subfolder", async () => {
    stubInertObserver();
    const calls = stubFetch();
    await open({ kind: "loadimage" }, "run/a.png");
    await navigate(
      calls,
      () => tapCard(document.querySelector(".ip-card.is-dir")),
      (q) => q.get("subfolder") === "run/sub",
      "for run/sub",
    );
    expect(calls.list.at(-1).get("type")).toBe("input");
  });

  it("the .. card ascends one level on a sandboxed root", async () => {
    stubInertObserver();
    const calls = stubFetch();
    await open({ kind: "loadimage" }, "run/deep/a.png");
    expect(calls.list.at(-1).get("subfolder")).toBe("run/deep");
    await navigate(
      calls,
      () => tapCard(document.querySelector(".ip-card.is-up")),
      (q) => q.get("subfolder") === "run",
      "for run",
    );
  });

  it("the .. card ascends one level on a path picker, and stops at /", async () => {
    stubInertObserver();
    const calls = stubFetch();
    await open({ kind: "vhs-path" }, "/abs/dir/a.png");
    expect(calls.list.at(-1).get("path")).toBe("/abs/dir");
    // Two levels, so "one level" is distinguishable from "straight to /".
    await navigate(
      calls,
      () => tapCard(document.querySelector(".ip-card.is-up")),
      (q) => q.get("path") === "/abs",
      "for /abs",
    );
    await navigate(
      calls,
      () => tapCard(document.querySelector(".ip-card.is-up")),
      (q) => q.get("path") === "/",
      "for /",
    );
    // At the filesystem root there is nothing above, so no `..` card.
    expect(document.querySelector(".ip-card.is-up")).toBeNull();
  });

  it("no .. card at a sandboxed root — the paired negative", async () => {
    stubInertObserver();
    stubFetch();
    await open({ kind: "loadimage" }, "a.png");
    expect(document.querySelector(".ip-card.is-up")).toBeNull();
    expect(document.querySelector(".ip-card.is-dir")).not.toBeNull();
  });

  it("sandboxed breadcrumbs carry data-sub and jump straight to that level", async () => {
    stubInertObserver();
    const calls = stubFetch();
    await open({ kind: "loadimage" }, "run/deep/a.png");
    expect([...document.querySelectorAll(".ip-crumb")].map((c) => c.textContent)).toEqual([
      "input",
      "run",
      "deep",
    ]);
    // Each crumb carries the path TO it, not just its own segment.
    expect(crumb("run").dataset.sub).toBe("run");
    expect(crumb("deep").dataset.sub).toBe("run/deep");
    expect(crumb("run").hasAttribute("data-abs")).toBe(false);

    await navigate(
      calls,
      () => crumb("run").click(),
      (q) => q.get("subfolder") === "run",
      "for run",
    );
    await navigate(
      calls,
      () => crumb("input").click(),
      (q) => q.get("subfolder") === "",
      "for the root",
    );
    expect(calls.list.at(-1).get("type")).toBe("input");
  });

  it("path breadcrumbs carry data-abs and jump to that absolute directory", async () => {
    stubInertObserver();
    const calls = stubFetch();
    await open({ kind: "vhs-path" }, "/abs/dir/a.png");
    expect([...document.querySelectorAll(".ip-crumb")].map((c) => c.textContent)).toEqual([
      "/",
      "abs",
      "dir",
    ]);
    expect(crumb("abs").dataset.abs).toBe("/abs");
    expect(crumb("dir").dataset.abs).toBe("/abs/dir");
    expect(crumb("abs").hasAttribute("data-sub")).toBe(false);

    await navigate(
      calls,
      () => crumb("abs").click(),
      (q) => q.get("path") === "/abs",
      "for /abs",
    );
    await navigate(
      calls,
      () => crumb("/").click(),
      (q) => q.get("path") === "/",
      "for /",
    );
  });

  it("switching tabs lists the new root from its TOP, not the old subfolder", async () => {
    stubInertObserver();
    const calls = stubFetch();
    await open({ kind: "loadimage" }, "run/deep/a.png");
    await navigate(
      calls,
      () => document.querySelector('.ip-tab[data-type="output"]').click(),
      (q) => q.get("type") === "output",
      "for output",
    );
    expect(calls.list.at(-1).get("subfolder")).toBe("");
    expect(document.querySelector(".ip-tab.is-active").dataset.type).toBe("output");
  });

  it("tapping the tab already active does not reload", async () => {
    stubInertObserver();
    const calls = stubFetch();
    await open({ kind: "loadimage" }, "run/deep/a.png");
    const before = calls.list.length;
    document.querySelector('.ip-tab[data-type="input"]').click();
    // Give a reload every chance to happen before asserting it did not.
    await new Promise((r) => setTimeout(r, 20));
    expect(calls.list.length).toBe(before);
  });
});
