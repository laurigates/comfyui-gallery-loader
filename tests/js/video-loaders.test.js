// @vitest-environment jsdom
//
// Node detection for the video / audio / directory combo loaders: core
// LoadVideo and LoadAudio, VHS's upload-flavour VHS_LoadVideo /
// VHS_LoadVideoFFmpeg / VHS_LoadAudioUpload, and VHS_LoadImages.
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

/** The default listing: one folder and one clip. */
const ONE_CLIP = [{ name: "clip.mp4", ext: ".mp4", mtime: 3, size: 99, rating: 0 }];

/**
 * Records every /list URL; serves one folder and whatever `files` says.
 *
 * The file list is a PARAMETER rather than a fixture constant: the audio tests
 * need an audio row and a non-media row in the same grid, and adding those to
 * the shared listing would silently change which card `.ip-card.is-file` picks
 * for every commit test in this file.
 */
function stubFetchRecording(files = ONE_CLIP) {
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
      // The pin list is fetched on every load (the chips show on every tab).
      // Kept out of `calls.list` so a listing assertion reading .at(-1) is not
      // silently reading the pin request instead.
      if (s.includes("/gallery_loader/pins")) {
        return { ok: true, status: 200, json: async () => ({ ok: true, max: 200, pins: [] }) };
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
          files,
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
  // `.ip-grid` exists the instant the shell opens, so waiting on it alone
  // returns before the listing has painted — wait for the grid's CONTENT.
  await vi.waitFor(() => {
    if (!document.querySelector(".ip-card, .ip-empty")) throw new Error("grid did not paint");
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
  // the combo lists images, videos or audio, so a boolean "was defanged"
  // marker would silently give every video loader the image extension set.
  it("strips audio_upload too, now that the picker serves it", () => {
    const out = defang({ required: { audio: ["COMBO", { audio_upload: true }] } });
    expect(out.required.audio[1]).toMatchObject({
      audio_upload: false,
      _origUploadFlag: "audio_upload",
    });
  });

  // The paired negative for the three assertions above: a defang hard-wired to
  // strip every `*_upload` key would satisfy all of them and would also break
  // the mesh combo's native control, which the picker cannot replace.
  it("leaves upload kinds the picker cannot serve alone", () => {
    const out = defang({
      required: {
        mesh: ["COMBO", { mesh_upload: true }],
        anim: ["COMBO", { animated_image_upload: true }],
      },
    });
    expect(out.required.mesh[1].mesh_upload).toBe(true);
    expect(out.required.mesh[1]._origUploadFlag).toBeUndefined();
    expect(out.required.anim[1].animated_image_upload).toBe(true);
    expect(out.required.anim[1]._origUploadFlag).toBeUndefined();
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

    // Input / Output / Temp, plus the pinned view (a file picker, so it is
    // offered here too).
    expect([...document.querySelectorAll(".ip-tab")].map((b) => b.dataset.type)).toEqual([
      "input",
      "output",
      "temp",
      "pinned",
    ]);
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

describe("audio loaders (issue #88)", () => {
  const audioWidget = (name, opts) => ({
    name,
    value: "take.flac",
    type: "combo",
    options: { values: [], ...opts },
  });

  // Core LoadAudio builds its own combo with
  // filter_files_content_types(files, ["audio", "video"]) — it reads the audio
  // track out of a video container — so an audio-only set would hide files the
  // node's native dropdown offers. Asserted two-sided: the audio extension the
  // widening exists for must be present AND the image default must be gone, so
  // a picker that fell back to the backend's default (images) fails, and one
  // that asked for every extension fails too.
  it("core LoadAudio asks for audio AND video, never the image default", async () => {
    stubInertObserver();
    const calls = stubFetchRecording();
    await openVia(fakeNode("LoadAudio", audioWidget("audio", { _origUploadFlag: "audio_upload" })));

    const exts = lastExtensions(calls);
    expect(exts).toContain(".flac");
    expect(exts).toContain(".m4a");
    expect(exts).toContain(".mp4");
    expect(exts).not.toContain(".png");
  });

  it("core LoadAudio is still detected by class name when the defang never ran", async () => {
    stubInertObserver();
    const calls = stubFetchRecording();
    await openVia(fakeNode("LoadAudio", audioWidget("audio")));

    expect(lastExtensions(calls)).toContain(".flac");
  });

  // VHS's own `audio_extensions` is mp3/mp4/wav/ogg — narrower than our
  // AUDIO_EXTS and, unlike it, carrying .mp4. The grid must offer exactly what
  // the node's native dropdown does, so this is an EQUALITY assertion: a set
  // that merely contains .mp3 would pass a containment check while listing
  // files VHS_LoadAudioUpload cannot load.
  it("VHS_LoadAudioUpload lists VHS's own audio set, not ours", async () => {
    stubInertObserver();
    const calls = stubFetchRecording();
    await openVia(fakeNode("VHS_LoadAudioUpload", audioWidget("audio")));

    expect(new Set(lastExtensions(calls))).toEqual(new Set([".mp3", ".mp4", ".wav", ".ogg"]));
  });

  it("VHS_LoadAudioUpload commits an annotated value", async () => {
    stubInertObserver();
    stubFetchRecording([{ name: "take.flac", ext: ".flac", mtime: 3, size: 42, rating: 0 }]);
    const widget = audioWidget("audio");
    await openVia(fakeNode("VHS_LoadAudioUpload", widget));

    document.querySelector('.ip-tab[data-type="output"]').click();
    await vi.waitFor(() => {
      if (!document.querySelector(".ip-card.is-file")) throw new Error("grid not repainted");
    });
    document.querySelector(".ip-card.is-file").click();
    expect(widget.value).toBe("take.flac [output]");
  });

  // VHS_LoadAudio is a PATH loader: it declares vhs_path_extensions on its
  // `audio_file` STRING widget, so nothing about the extension set is
  // hardcoded here — the only thing under test is that the class is in
  // VHS_PATH_LOADERS at all. The set below is VHS's, verbatim.
  it("VHS_LoadAudio (path) is taken over and asks for the widget's own set", async () => {
    stubInertObserver();
    const calls = stubFetchRecording();
    const widget = {
      name: "audio_file",
      value: "input/",
      type: "string",
      options: { vhs_path_extensions: [".wav", ".mp3", ".ogg", ".m4a", ".flac"] },
    };
    await openVia(fakeNode("VHS_LoadAudio", widget));

    expect(new Set(lastExtensions(calls))).toEqual(
      new Set([".wav", ".mp3", ".ogg", ".m4a", ".flac"]),
    );
    expect(lastType(calls)).toBe("path");
  });
});

describe("audio cards in the grid", () => {
  // One listing, three kinds. Asserted in ONE test so the audio branch cannot
  // be satisfied by a thumbForFile hard-wired to return the audio kind for
  // everything: that implementation would paint the video and the .txt as
  // audio too, and both paired assertions below would fail.
  it("paints a 🎵 glyph for audio, a <video> for video, and 📄 for the rest", async () => {
    stubInertObserver();
    stubFetchRecording([
      { name: "clip.mp4", ext: ".mp4", mtime: 3, size: 99, rating: 0 },
      { name: "take.flac", ext: ".flac", mtime: 2, size: 42, rating: 0 },
      { name: "notes.txt", ext: ".txt", mtime: 1, size: 7, rating: 0 },
    ]);
    await openVia(
      fakeNode("LoadAudio", {
        name: "audio",
        value: "take.flac",
        type: "combo",
        options: { values: [], _origUploadFlag: "audio_upload" },
      }),
    );

    const cardFor = (name) => document.querySelector(`.ip-card.is-file[data-name="${name}"]`);
    const audio = cardFor("take.flac");
    const video = cardFor("clip.mp4");
    const other = cardFor("notes.txt");
    // The grid must actually hold all three, or every assertion below is
    // vacuously true against an empty query result.
    expect([audio, video, other].every(Boolean)).toBe(true);

    expect(audio.querySelector(".ip-thumb-icon.is-audio")?.textContent).toBe("🎵");
    // ...and it is NOT the generic file icon, which is what it fell through to
    // before this change.
    expect(audio.querySelector(".ip-thumb-icon").textContent).not.toBe("📄");
    expect(audio.querySelector(".ip-thumb video")).toBeNull();

    expect(video.querySelector(".ip-thumb video")).not.toBeNull();
    expect(video.querySelector(".ip-thumb-icon.is-audio")).toBeNull();

    expect(other.querySelector(".ip-thumb-icon").textContent).toBe("📄");
    expect(other.querySelector(".ip-thumb-icon.is-audio")).toBeNull();
  });

  // An <audio controls> inside .ip-thumb would sit under the grid's own click
  // handler, which commits the file and closes the modal for any click that is
  // not a star / 📌 / 🙈 / ⓘ / subpath — so the first tap at its play button
  // would dismiss the picker. The card must carry no media element at all.
  it("mounts no <audio> element, so a tap on the card still selects the file", async () => {
    stubInertObserver();
    stubFetchRecording([{ name: "take.flac", ext: ".flac", mtime: 3, size: 42, rating: 0 }]);
    const widget = {
      name: "audio",
      value: "",
      type: "combo",
      options: { values: [], _origUploadFlag: "audio_upload" },
    };
    await openVia(fakeNode("LoadAudio", widget));

    const card = document.querySelector(".ip-card.is-file");
    expect(card.querySelector("audio")).toBeNull();
    // The paired positive: the card is a live select target, not an inert one.
    card.querySelector(".ip-thumb").click();
    expect(widget.value).toBe("take.flac");
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
