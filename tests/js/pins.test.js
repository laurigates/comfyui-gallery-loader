// @vitest-environment jsdom
//
// Server-side pins: the pinned tab, the per-card 📌, and the address sweep the
// pinned view depends on.
//
// The load-bearing case is "a pinned card commits its OWN root". Folder and
// flat view both live under one `state.type`, so every per-file address could
// read it directly; the pinned view mixes roots in one grid, so each card must
// address through `fileType(f)`.
//
// Verified by reverting `fileType()` to `return state.type;`, which turns four
// of these red — the observed failures were:
//
//   AssertionError: expected 'in.png [pinned]' to be 'in.png'
//   AssertionError: expected 'pinned' to be 'input'          (thumbnail ?type=)
//   AssertionError: expected 'pinned/2026-08-04' to be 'output/2026-08-04'
//   (plus the card 📌 delta, which stops being offered at all)
import { beforeEach, describe, expect, it, vi } from "vitest";
import { openImagePicker } from "../../src/image-picker.ts";

/** What /list serves on the ordinary tabs. */
const FILES = [{ name: "a.png", ext: ".png", mtime: 3, size: 10, width: 8, height: 8, rating: 0 }];

/**
 * What GET /pins serves. Deliberately spans two roots plus one unresolvable
 * entry — the three things folder view can never produce.
 */
const PINS = [
  { kind: "dir", type: "output", subfolder: "keep", exists: true },
  {
    kind: "file",
    type: "input",
    subfolder: "",
    name: "in.png",
    exists: true,
    ext: ".png",
    mtime: 5,
    size: 10,
    width: 8,
    height: 8,
    rating: 0,
  },
  {
    kind: "file",
    type: "output",
    subfolder: "2026-08-04",
    name: "a.png",
    exists: true,
    ext: ".png",
    mtime: 4,
    size: 10,
    width: 8,
    height: 8,
    rating: 0,
  },
  // No stats at all, exactly as the endpoint answers an unresolvable pin.
  { kind: "file", type: "output", subfolder: "gone", name: "ghost.png", exists: false },
];

const keyOf = (p) => [p.kind, p.type, p.subfolder ?? "", p.name ?? ""].join(":");
const reply = (body) => ({ ok: true, status: 200, json: async () => body });

/** Never intersects, so no thumbnail is ever fetched. */
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
 * Serves /base, /list and both /pins verbs, applying each delta to a live list
 * so the POST response is the same shape the real endpoint answers with (the
 * whole freshly-resolved list, never an ack).
 */
function stubFetch(pins = PINS) {
  const store = { pins: [...pins], posts: [] };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url, init) => {
      const s = String(url);
      if (s.includes("/gallery_loader/base")) {
        return reply({ ok: true, base_path: "/", input_dir: "", output_dir: "" });
      }
      if (s.includes("/gallery_loader/pins")) {
        if (init?.method === "POST") {
          const body = JSON.parse(init.body);
          store.posts.push(body);
          if (body.op === "prune") {
            store.pins = store.pins.filter((p) => p.exists !== false);
          } else if (body.op === "add") {
            store.pins = [...store.pins, { ...body.item, exists: true }];
          } else if (body.op === "remove") {
            store.pins = store.pins.filter((p) => keyOf(p) !== keyOf(body.item));
          }
        }
        return reply({ ok: true, max: 200, pins: store.pins });
      }
      return reply({
        ok: true,
        type: "input",
        subfolder: "",
        dirs: [],
        files: FILES,
        exists: true,
      });
    }),
  );
  return store;
}

async function openPicker() {
  const widget = { name: "image", value: "", type: "combo", options: { values: [] } };
  const node = {
    widgets: [widget],
    comfyClass: "LoadImage",
    type: "LoadImage",
    addWidget: () => ({}),
  };
  await openImagePicker(widget, node, { kind: "loadimage" });
  await vi.waitFor(() => {
    if (!document.querySelector(".ip-card")) throw new Error("grid not rendered");
  });
  return widget;
}

/**
 * Switch to the pinned tab and FLUSH the async render. The wait is on the
 * pinned view's own structural marker — a subpath label carrying the card's
 * root — so it is independent of whatever each test then asserts. Without the
 * flush the assertions would run against the previous tab's grid.
 */
async function openPinnedTab() {
  const widget = await openPicker();
  document.querySelector('.ip-tab[data-type="pinned"]').click();
  await vi.waitFor(() => {
    if (!document.querySelector(".ip-subpath[data-pin-type]")) {
      throw new Error("pinned grid did not paint");
    }
  });
  return widget;
}

const cardNamed = (name) => document.querySelector(`.ip-card.is-file[data-name="${name}"]`);

beforeEach(() => {
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
  localStorage.clear();
  stubInertObserver();
});

describe("pinned tab", () => {
  it("is offered on a sandboxed file picker and renders the pinned media", async () => {
    stubFetch();
    await openPinnedTab();

    // Non-emptiness first: every assertion below is vacuously true on an empty
    // grid, which is exactly what an un-flushed render produces.
    const cards = document.querySelectorAll(".ip-card.is-file");
    expect(cards.length).toBe(3);
    // Folder pins stay in the chip row; only file pins reach the grid.
    expect(document.querySelectorAll(".ip-pin-chip").length).toBe(1);
    expect(cardNamed("in.png")).not.toBeNull();
    expect(cardNamed("a.png")).not.toBeNull();
    expect(cardNamed("ghost.png")).not.toBeNull();
  });

  // Flat view and pin-this-folder are sandboxed-root concepts; the pinned view
  // is several roots at once, so both must stay off there.
  it("hides the flat toggle and the pin-this-folder toggle", async () => {
    stubFetch();
    await openPinnedTab();

    expect(document.querySelector(".ip-view-toggle").style.display).toBe("none");
    expect(document.querySelector(".ip-pin-toggle").style.display).toBe("none");
    // The chip row is how you LEAVE the pinned tab, so it stays.
    expect(document.querySelector(".ip-pins").style.display).not.toBe("none");
  });

  it("is not created in directory mode, where file cards are inert", async () => {
    stubFetch();
    const widget = { name: "directory", value: "", type: "combo", options: { values: [] } };
    await openImagePicker(
      widget,
      { widgets: [widget], comfyClass: "VHS_LoadImages", addWidget: () => ({}) },
      { kind: "loadimage", mode: "directory" },
    );
    await vi.waitFor(() => {
      if (!document.querySelector(".ip-tabs")) throw new Error("tabs not rendered");
    });

    expect(document.querySelector('.ip-tab[data-type="pinned"]')).toBeNull();
    expect(document.querySelectorAll(".ip-tab").length).toBe(3);
  });
});

describe("a pinned card addresses its own root", () => {
  // THE test for the fileType() sweep. Folder/flat view can never produce this
  // case: `state.type` is "pinned" here, so any address that reads it instead
  // of the card's own root is wrong for every card at once.
  it("commits an input pin bare and an output pin annotated", async () => {
    stubFetch();
    const inputWidget = await openPinnedTab();
    expect(document.querySelectorAll(".ip-card.is-file").length).toBe(3);
    cardNamed("in.png").click();
    // Bare relative — the Input value contract, unchanged by the pinned view.
    expect(inputWidget.value).toBe("in.png");

    document.body.innerHTML = "";
    const outputWidget = await openPinnedTab();
    expect(document.querySelectorAll(".ip-card.is-file").length).toBe(3);
    cardNamed("a.png").click();
    expect(outputWidget.value).toBe("2026-08-04/a.png [output]");
  });

  it("builds each thumbnail against the pin's own root and subfolder", async () => {
    stubFetch();
    await openPinnedTab();
    expect(document.querySelectorAll(".ip-card.is-file").length).toBe(3);

    const src = (name) =>
      new URL(cardNamed(name).querySelector("img").dataset.src, "http://localhost").searchParams;
    expect(src("in.png").get("type")).toBe("input");
    expect(src("in.png").get("subfolder")).toBe("");
    expect(src("a.png").get("type")).toBe("output");
    expect(src("a.png").get("subfolder")).toBe("2026-08-04");
  });

  it("navigates the subpath label to the pin's own root", async () => {
    const store = stubFetch();
    await openPinnedTab();
    expect(document.querySelectorAll(".ip-card.is-file").length).toBe(3);

    const label = cardNamed("a.png").querySelector(".ip-subpath");
    expect(label.textContent).toBe("output/2026-08-04");
    label.click();
    await vi.waitFor(() => {
      const last = store.posts.length; // unused; the listing call is what matters
      if (!document.querySelector('.ip-tab[data-type="output"].is-active')) {
        throw new Error(`did not land on the output tab (${last})`);
      }
    });
    const listing = fetch.mock.calls.map((c) => String(c[0])).filter((u) => u.includes("/list"));
    const params = new URL(listing.at(-1), "http://localhost").searchParams;
    expect(params.get("type")).toBe("output");
    expect(params.get("subfolder")).toBe("2026-08-04");
  });
});

describe("card 📌", () => {
  it("posts an add delta for the card's own address and does NOT commit", async () => {
    const store = stubFetch();
    const widget = await openPicker();

    const btn = cardNamed("a.png").querySelector(".ip-pin-file");
    expect(btn).not.toBeNull();
    btn.click();
    await vi.waitFor(() => {
      if (!store.posts.length) throw new Error("no delta posted");
    });

    expect(store.posts).toEqual([
      { op: "add", item: { kind: "file", type: "input", subfolder: "", name: "a.png" } },
    ]);
    // A pin tap must not commit the value or close the modal.
    expect(widget.value).toBe("");
    expect(document.querySelector(".ip-grid")).not.toBeNull();
    await vi.waitFor(() => {
      if (!btn.classList.contains("is-pinned")) throw new Error("button did not light up");
    });
  });

  it("posts a remove delta when the file is already pinned", async () => {
    // The listing's a.png IS the pinned input file here, so the card opens
    // already pinned.
    const store = stubFetch([
      { kind: "file", type: "input", subfolder: "", name: "a.png", exists: true, ext: ".png" },
    ]);
    await openPicker();

    const btn = cardNamed("a.png").querySelector(".ip-pin-file");
    expect(btn.classList.contains("is-pinned")).toBe(true);
    btn.click();
    await vi.waitFor(() => {
      if (!store.posts.length) throw new Error("no delta posted");
    });

    expect(store.posts[0].op).toBe("remove");
    expect(store.posts[0].item).toEqual({
      kind: "file",
      type: "input",
      subfolder: "",
      name: "a.png",
    });
  });

  it("posts the pin's own root when pinning from the pinned tab", async () => {
    const store = stubFetch();
    await openPinnedTab();
    expect(document.querySelectorAll(".ip-card.is-file").length).toBe(3);

    cardNamed("a.png").querySelector(".ip-pin-file").click();
    await vi.waitFor(() => {
      if (!store.posts.length) throw new Error("no delta posted");
    });
    expect(store.posts[0]).toEqual({
      op: "remove",
      item: { kind: "file", type: "output", subfolder: "2026-08-04", name: "a.png" },
    });
  });
});

describe("folder pins read and write the server store", () => {
  it("posts a dir delta from the toolbar toggle", async () => {
    const store = stubFetch();
    await openPicker();

    document.querySelector(".ip-pin-toggle").click();
    await vi.waitFor(() => {
      if (!store.posts.length) throw new Error("no delta posted");
    });
    expect(store.posts[0]).toEqual({
      op: "add",
      item: { kind: "dir", type: "input", subfolder: "" },
    });
  });

  it("renders a chip per dir pin, not per file pin", async () => {
    stubFetch();
    await openPicker();

    const chips = document.querySelectorAll(".ip-pin-chip");
    expect(chips.length).toBe(1);
    expect(chips[0].dataset.pinType).toBe("output");
    expect(chips[0].dataset.pinSub).toBe("keep");
  });
});

describe("stale pins", () => {
  // Asserted through getComputedStyle, never el.style: the pack injects its CSS
  // through ensureStyleOnce and the declaration lives in a class rule, so an
  // el.style read would be "" and would pass against the bug.
  it("renders an exists:false pin dimmed", async () => {
    stubFetch();
    await openPinnedTab();
    expect(document.querySelectorAll(".ip-card.is-file").length).toBe(3);

    const ghost = cardNamed("ghost.png");
    const live = cardNamed("a.png");
    expect(getComputedStyle(ghost).opacity).toBe("0.45");
    expect(getComputedStyle(live).opacity).not.toBe("0.45");
  });

  it("refuses to commit a pin that no longer resolves", async () => {
    stubFetch();
    const widget = await openPinnedTab();
    expect(document.querySelectorAll(".ip-card.is-file").length).toBe(3);

    cardNamed("ghost.png").click();
    expect(widget.value).toBe("");
    expect(document.querySelector(".ip-grid")).not.toBeNull();
  });

  // A missing pin has no stats, so its mtime/size arrive undefined. Number(
  // undefined) is NaN, and one NaN reorders the WHOLE list, not just that card.
  it("normalises a missing pin's stats so the sort stays stable", async () => {
    stubFetch();
    await openPinnedTab();

    const order = [...document.querySelectorAll(".ip-card.is-file")].map((c) => c.dataset.name);
    expect(order).toEqual(["in.png", "a.png", "ghost.png"]);
  });

  it("offers Prune missing only where the stale pins are visible", async () => {
    stubFetch();
    await openPicker();
    expect(document.querySelector(".ip-prune").style.display).toBe("none");
  });

  it("posts a prune delta and drops the missing cards", async () => {
    const store = stubFetch();
    await openPinnedTab();
    // Flush first: the prune control is painted by renderPins BEFORE the grid
    // repaints, so an un-flushed assertion here would be counting the previous
    // tab's cards.
    expect(document.querySelectorAll(".ip-card.is-file").length).toBe(3);
    expect(document.querySelector(".ip-prune").style.display).not.toBe("none");

    document.querySelector(".ip-prune").click();
    await vi.waitFor(() => {
      if (cardNamed("ghost.png")) throw new Error("pruned card still painted");
    });
    expect(store.posts).toEqual([{ op: "prune" }]);
    expect(document.querySelectorAll(".ip-card.is-file").length).toBe(2);
  });
});
