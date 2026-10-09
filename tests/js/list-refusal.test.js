// @vitest-environment jsdom
//
// A refused listing shows the backend's reason, not a bare status code.
//
// /list answers 403 with {ok:false, error} for a path outside ComfyUI's
// directories (issue #121), and that error names the fix: register the folder
// in extra_model_paths.yaml or symlink it inside the tree. The picker used to
// throw `HTTP ${status}` on any non-2xx before reading the body, so the user
// saw "Error: HTTP 403" and nothing about how to get the folder back.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { openImagePicker } from "../../src/image-picker.ts";

const REFUSAL =
  "path is outside ComfyUI's directories. To browse another folder, register it in " +
  "extra_model_paths.yaml or symlink it inside the ComfyUI tree, then restart ComfyUI.";

const reply = (status, body) => ({ ok: status < 400, status, json: async () => body });

beforeEach(() => {
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
  localStorage.clear();
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
});

describe("a refused /list", () => {
  it("puts the backend's error in the status line", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url) => {
        const s = String(url);
        if (s.includes("/gallery_loader/base")) {
          return reply(200, { ok: true, base_path: "/comfy", input_dir: "", output_dir: "" });
        }
        if (s.includes("/gallery_loader/pins")) return reply(200, { ok: true, max: 200, pins: [] });
        return reply(403, { ok: false, error: REFUSAL });
      }),
    );
    const widget = { name: "image", value: "", type: "combo", options: { values: [] } };
    const node = {
      widgets: [widget],
      comfyClass: "LoadImage",
      type: "LoadImage",
      addWidget: () => ({}),
    };
    await openImagePicker(widget, node, { kind: "loadimage" });

    await vi.waitFor(() => {
      const status = document.querySelector(".cmp-status")?.textContent ?? "";
      if (!status.startsWith("Error:")) throw new Error(`status not painted: ${status}`);
    });
    const status = document.querySelector(".cmp-status").textContent;
    expect(status).toContain("extra_model_paths.yaml");
    expect(status).not.toContain("HTTP 403");
  });

  it("still names the status when the body is not JSON", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url) => {
        const s = String(url);
        if (s.includes("/gallery_loader/base")) {
          return reply(200, { ok: true, base_path: "/comfy", input_dir: "", output_dir: "" });
        }
        if (s.includes("/gallery_loader/pins")) return reply(200, { ok: true, max: 200, pins: [] });
        return {
          ok: false,
          status: 502,
          json: async () => {
            throw new SyntaxError("Unexpected token <");
          },
        };
      }),
    );
    const widget = { name: "image", value: "", type: "combo", options: { values: [] } };
    const node = {
      widgets: [widget],
      comfyClass: "LoadImage",
      type: "LoadImage",
      addWidget: () => ({}),
    };
    await openImagePicker(widget, node, { kind: "loadimage" });

    await vi.waitFor(() => {
      const status = document.querySelector(".cmp-status")?.textContent ?? "";
      if (!status.startsWith("Error:")) throw new Error(`status not painted: ${status}`);
    });
    expect(document.querySelector(".cmp-status").textContent).toContain("HTTP 502");
  });
});
