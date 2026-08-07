// @vitest-environment jsdom
//
// Node detection for the video / directory combo loaders: core LoadVideo, VHS's
// upload-flavour VHS_LoadVideo / VHS_LoadVideoFFmpeg, and VHS_LoadImages.
//
// These drive the REGISTERED extension hooks rather than calling openImagePicker
// directly, because the thing under test is the detection itself — which classes
// are taken over, which widget is hooked, and which extension set the picker
// then asks the backend for. Calling openImagePicker with hand-built opts would
// assert the harness, not the code.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { extensionNamed } from "./__mocks__/app.js";
// Imported for the side-effect: the module registers its extension on load.
import "../../src/image-picker.ts";

const EXT = "comfy.gallery-loader.image-picker";

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

/** Records every /list URL; serves one folder and one clip. */
function stubFetchRecording() {
  const calls = { list: [] };
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
      calls.list.push(s);
      return {
        ok: true,
        status: 200,
        json: async () => ({
          ok: true,
          type: "input",
          subfolder: "",
          dirs: [{ name: "sub", mtime: 1 }],
          files: [{ name: "clip.mp4", ext: ".mp4", mtime: 3, size: 99, rating: 0 }],
          exists: true,
        }),
      };
    }),
  );
  return calls;
}

/**
 * A node whose `addWidget` records appended button widgets, so a test can drive
 * the same click path a user takes (Strategy B), not a synthesised call.
 */
function fakeNode(comfyClass, widget) {
  const buttons = [];
  return {
    comfyClass,
    type: comfyClass,
    widgets: [widget],
    buttons,
    addWidget: (type, label, value, callback) => {
      const w = { type, name: label, value, callback, options: {} };
      buttons.push(w);
      return w;
    },
    setDirtyCanvas: () => {},
  };
}

/** Run the registered nodeCreated hook, then open via the 📁 button. */
async function openVia(node) {
  extensionNamed(EXT).nodeCreated(node);
  const btn = node.buttons.at(-1);
  if (!btn) throw new Error("no button widget was appended");
  btn.callback();
  await vi.waitFor(() => {
    if (!document.querySelector(".ip-grid")) throw new Error("picker did not open");
  });
  return btn;
}

/** The `extensions` query param of the most recent listing, as an array. */
function lastExtensions(calls) {
  const raw = new URL(calls.list.at(-1), "http://localhost").searchParams.get("extensions");
  return raw ? raw.split(",") : null;
}

function lastType(calls) {
  return new URL(calls.list.at(-1), "http://localhost").searchParams.get("type");
}

beforeEach(() => {
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe("upload-flag defang", () => {
  const defang = (input) => {
    extensionNamed(EXT).beforeRegisterNodeDef({}, { name: "T", input });
    return input;
  };

  it("records WHICH flag it stripped, for image and video alike", () => {
    const out = defang({
      required: {
        image: ["COMBO", { image_upload: true }],
        file: ["COMBO", { video_upload: true }],
      },
    });
    expect(out.required.image[1]).toMatchObject({
      image_upload: false,
      _origUploadFlag: "image_upload",
    });
    expect(out.required.file[1]).toMatchObject({
      video_upload: false,
      _origUploadFlag: "video_upload",
    });
  });

  // The flag is the only thing left on a constructed widget that says whether
  // the combo lists images or videos, so a boolean "was defanged" marker would
  // silently give every video loader the image extension set.
  it("leaves upload kinds the picker cannot serve alone", () => {
    const out = defang({
      required: {
        audio: ["COMBO", { audio_upload: true }],
        mesh: ["COMBO", { mesh_upload: true }],
      },
    });
    expect(out.required.audio[1].audio_upload).toBe(true);
    expect(out.required.audio[1]._origUploadFlag).toBeUndefined();
    expect(out.required.mesh[1].mesh_upload).toBe(true);
  });
});

describe("core LoadVideo", () => {
  const videoWidget = (value = "clip.mp4") => ({
    name: "file",
    value,
    type: "combo",
    options: { values: [], _origUploadFlag: "video_upload" },
  });

  it("lists videos, not the backend's default image set", async () => {
    stubInertObserver();
    const calls = stubFetchRecording();
    await openVia(fakeNode("LoadVideo", videoWidget()));

    const exts = lastExtensions(calls);
    expect(exts).toContain(".mp4");
    expect(exts).toContain(".webm");
    expect(exts).not.toContain(".png");
  });

  // Sandboxed flavour: the same Input/Output/Temp tabs as LoadImage, because
  // LoadVideo resolves its value through get_annotated_filepath too.
  it("offers the source tabs and commits an annotated value", async () => {
    stubInertObserver();
    stubFetchRecording();
    const widget = videoWidget();
    await openVia(fakeNode("LoadVideo", widget));

    expect(document.querySelectorAll(".ip-tab").length).toBe(3);
    document.querySelector('.ip-tab[data-type="output"]').click();
    await vi.waitFor(() => {
      if (!document.querySelector(".ip-card.is-file")) throw new Error("grid not repainted");
    });
    document.querySelector(".ip-card.is-file").click();
    expect(widget.value).toBe("clip.mp4 [output]");
    // Committed values must validate against the combo's own options list.
    expect(widget.options.values).toContain("clip.mp4 [output]");
  });

  // Strategy A's defang runs in beforeRegisterNodeDef; a node registered before
  // our hook (or an older frontend) reaches nodeCreated with no marker at all.
  it("is still detected by class name when the defang never ran", async () => {
    stubInertObserver();
    const calls = stubFetchRecording();
    const widget = videoWidget();
    widget.options = { values: [] };
    await openVia(fakeNode("LoadVideo", widget));

    expect(lastExtensions(calls)).toContain(".mp4");
  });
});

describe("VHS upload combos", () => {
  // VHS's own `video_extensions` includes gif and excludes .avi/.m4v/.mpg —
  // the grid must offer exactly what the node's native dropdown does, not our
  // broader VIDEO_EXTS.
  it.each(["VHS_LoadVideo", "VHS_LoadVideoFFmpeg"])("%s lists VHS's own set", async (cls) => {
    stubInertObserver();
    const calls = stubFetchRecording();
    const widget = { name: "video", value: "clip.mp4", type: "combo", options: { values: [] } };
    await openVia(fakeNode(cls, widget));

    const exts = lastExtensions(calls);
    expect(new Set(exts)).toEqual(new Set([".webm", ".mp4", ".mkv", ".gif", ".mov"]));
  });

  it("commits an annotated value VHS resolves through get_annotated_filepath", async () => {
    stubInertObserver();
    stubFetchRecording();
    const widget = { name: "video", value: "clip.mp4", type: "combo", options: { values: [] } };
    await openVia(fakeNode("VHS_LoadVideo", widget));

    document.querySelector('.ip-tab[data-type="temp"]').click();
    await vi.waitFor(() => {
      if (!document.querySelector(".ip-card.is-file")) throw new Error("grid not repainted");
    });
    document.querySelector(".ip-card.is-file").click();
    expect(widget.value).toBe("clip.mp4 [temp]");
  });
});

describe("VHS_LoadImages (directory combo)", () => {
  const dirWidget = (value) => ({
    name: "directory",
    value,
    type: "combo",
    options: { values: [] },
  });

  async function openDir(value) {
    const widget = dirWidget(value);
    await openVia(fakeNode("VHS_LoadImages", widget));
    return widget;
  }

  it("opens in directory mode — no files listed, footer commits the folder", async () => {
    stubInertObserver();
    const calls = stubFetchRecording();
    await openDir("frames");

    // The sentinel the backend intersects to nothing, leaving only folders.
    expect(lastExtensions(calls)).toEqual([".__none__"]);
    expect(document.querySelector(".ip-use-folder")).not.toBeNull();
    // Flat view is meaningless without files, so the toggle is not created.
    expect(document.querySelector(".ip-view-toggle")).toBeNull();
  });

  it("opens INSIDE the currently selected folder", async () => {
    stubInertObserver();
    const calls = stubFetchRecording();
    await openDir("frames");

    const sub = new URL(calls.list.at(-1), "http://localhost").searchParams.get("subfolder");
    expect(sub).toBe("frames");
    expect(lastType(calls)).toBe("input");
  });

  it("round-trips an annotated folder value", async () => {
    stubInertObserver();
    const calls = stubFetchRecording();
    const widget = await openDir("a/b [output]");

    expect(lastType(calls)).toBe("output");
    document.querySelector(".ip-use-folder").click();
    expect(widget.value).toBe("a/b [output]");
  });

  // "" would serialize as a blank widget value that reads as "nothing chosen";
  // "." is joined onto the base dir and normalised away by abspath.
  it("commits '.' rather than an empty string at a root", async () => {
    stubInertObserver();
    stubFetchRecording();
    const widget = await openDir("");

    document.querySelector(".ip-use-folder").click();
    expect(widget.value).toBe(".");
  });

  it("descends into a folder card and commits the nested path", async () => {
    stubInertObserver();
    stubFetchRecording();
    const widget = await openDir("frames");

    document.querySelector(".ip-card.is-dir").click();
    await vi.waitFor(() => {
      const btn = document.querySelector(".ip-use-folder");
      if (!btn?.textContent.includes("frames/sub")) throw new Error("did not descend");
    });
    document.querySelector(".ip-use-folder").click();
    expect(widget.value).toBe("frames/sub");
  });
});
