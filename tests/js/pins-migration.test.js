// @vitest-environment jsdom
//
// The one-shot drain of the OLD localStorage folder-pin list into the server
// store. In its own file on purpose: the migration guard is module-level state,
// so a second run in the same module registry is a no-op by design and would
// make an ordering-dependent assertion in the main pins suite look green for
// the wrong reason.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { openImagePicker } from "../../src/image-picker.ts";

const LEGACY_KEY = "comfyui-gallery-loader:pins";
const reply = (body) => ({ ok: true, status: 200, json: async () => body });

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

function stubFetch({ failPost = false } = {}) {
  const store = { pins: [], posts: [] };
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
          if (failPost) {
            return { ok: false, status: 500, json: async () => ({ ok: false, error: "boom" }) };
          }
          store.posts.push(body);
          store.pins = [...store.pins, { ...body.item, exists: true }];
        }
        return reply({ ok: true, max: 200, pins: store.pins });
      }
      return reply({ ok: true, type: "input", subfolder: "", dirs: [], files: [], exists: true });
    }),
  );
  return store;
}

async function openPicker() {
  const widget = { name: "image", value: "", type: "combo", options: { values: [] } };
  await openImagePicker(
    widget,
    { widgets: [widget], comfyClass: "LoadImage", addWidget: () => ({}) },
    { kind: "loadimage" },
  );
  await vi.waitFor(() => {
    if (!document.querySelector(".ip-grid")) throw new Error("picker did not open");
  });
}

beforeEach(() => {
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
  stubInertObserver();
});

describe("localStorage → server pin migration", () => {
  it("replays each legacy folder pin as an add delta, then clears the key", async () => {
    localStorage.clear();
    localStorage.setItem(
      LEGACY_KEY,
      JSON.stringify([
        { type: "output", subfolder: "keep" },
        { type: "input", subfolder: "" },
        // Never addressable as a pin — the store rejects a non-sandboxed type.
        { type: "path", subfolder: "/etc" },
      ]),
    );
    const store = stubFetch();

    await openPicker();
    await vi.waitFor(() => {
      if (localStorage.getItem(LEGACY_KEY) !== null) throw new Error("key not cleared");
    });

    expect(store.posts).toEqual([
      { op: "add", item: { kind: "dir", type: "output", subfolder: "keep" } },
      { op: "add", item: { kind: "dir", type: "input", subfolder: "" } },
    ]);
    // Chips render from the list the POSTs answered with — no follow-up GET
    // needed for them to appear.
    await vi.waitFor(() => {
      if (document.querySelectorAll(".ip-pin-chip").length !== 2) {
        throw new Error("chips not painted from the migrated list");
      }
    });
  });

  // The guard is module-level, so this second open in the same registry must
  // post nothing — that IS the once-per-page property.
  it("does not run a second time", async () => {
    const store = stubFetch();
    localStorage.setItem(LEGACY_KEY, JSON.stringify([{ type: "temp", subfolder: "x" }]));

    document.body.innerHTML = "";
    await openPicker();
    await vi.waitFor(() => {
      if (!fetch.mock.calls.some((c) => String(c[0]).includes("/pins"))) {
        throw new Error("pins never fetched");
      }
    });

    expect(store.posts).toEqual([]);
    // The key is left alone rather than cleared by a run that never happened.
    expect(localStorage.getItem(LEGACY_KEY)).not.toBeNull();
  });
});
