// Playwright driver for the README screenshots.
//
// Drives ComfyUI's frontend through the pack's real public surface:
// loads a two-node workflow (stock LoadImage + GalleryLoadImage), then
//
//   1. screenshots the inline card grid mounted on the GalleryLoadImage
//      node body (.gl-root) — the headline "node" entry point, and
//   2. opens the modal picker over the stock LoadImage node and
//      screenshots the dialog (.cmp-dialog) — the headline "modal"
//      entry point.
//
// Direct widget invocation is intentional: clicking the canvas at
// computed coords is fragile (Vue layout, ds scale, devicePixelRatio
// all interact), and `widget.onPointerDown(pointer, node, canvas)` is
// the same public surface the pack hooks into — calling it directly
// exercises the exact code path a real click would. The 📁 Browse
// button (Strategy B) is the fallback if the hook doesn't open the
// modal on this frontend build.
//
// The grid renders REAL files; the Docker build seeds input/output/temp
// with sample images (see seed_images.py) so the grid isn't blank.

import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const HERE = dirname(fileURLToPath(import.meta.url));
const WORKFLOW_PATH = resolve(HERE, "workflow.json");
const OUT_DIR = process.env.OUT_DIR || "/out";
const BASE_URL = process.env.COMFYUI_URL || "http://127.0.0.1:8188/";
// Optional: type a filter into the modal search to show the fuzzy-match
// state. Empty (default) leaves the full mtime-sorted grid visible.
const PICKER_QUERY = process.env.PICKER_QUERY || "";

// Wait until at least one <img> inside `selector` has actually decoded
// (naturalWidth > 0), so the screenshot doesn't capture empty thumbs.
async function waitForThumbs(page, selector, timeout = 20_000) {
  await page.waitForFunction(
    (sel) => {
      const imgs = document.querySelectorAll(`${sel} img`);
      for (const im of imgs) {
        if (im.naturalWidth > 0) return true;
      }
      return false;
    },
    selector,
    { timeout },
  );
}

async function dismissStartupDialog(page) {
  // A fresh ComfyUI profile opens the "Workflow Templates / Getting
  // Started" browser — a PrimeVue dialog (.p-dialog-mask, z-index 1102)
  // that overlays the canvas. An element screenshot of .gl-root would
  // composite this overlay on top, so close it first. Escape triggers
  // PrimeVue's closeOnEscape; removing the mask is the deterministic
  // belt-and-braces.
  await page.keyboard.press("Escape");
  await page.waitForTimeout(150);
  await page.evaluate(() => {
    for (const el of document.querySelectorAll(".p-dialog-mask")) el.remove();
  });
}

async function captureGallery(page) {
  console.log("Locating GalleryLoadImage node…");
  // Normalize the canvas so the DOM-widget overlay lands in-viewport at
  // readable zoom. gallery_loader.js uses hideOnZoom:true, so scale must
  // be at/above the readability threshold — scale 1 is safe. Offset so
  // the node sits near the top-left.
  await page.evaluate(() => {
    const node = window.app.graph._nodes.find((n) => n.type === "GalleryLoadImage");
    if (!node) throw new Error("GalleryLoadImage node not found in graph");
    const ds = window.app.canvas.ds;
    ds.scale = 1;
    ds.offset[0] = 40 - node.pos[0];
    ds.offset[1] = 40 - node.pos[1];
    window.app.canvas.setDirty(true, true);
    window.app.canvas.draw(true, true);
  });

  // Wait for the DOM widget to mount and the grid to populate from the
  // seeded input/ dir.
  await page.waitForFunction(
    () => {
      const root = document.querySelector(".gl-root");
      return !!root && !!root.querySelector(".gl-card.is-file");
    },
    null,
    { timeout: 20_000 },
  );

  // The grid's IntersectionObserver root is the grid element itself, so
  // thumbnails load regardless of page-viewport position.
  await waitForThumbs(page, ".gl-root .gl-thumb");
  // Let the first rows settle.
  await page.waitForTimeout(500);

  console.log(`Capturing ${OUT_DIR}/gallery.png…`);
  await page.locator(".gl-root").screenshot({ path: `${OUT_DIR}/gallery.png` });
}

async function openPickerModal(page) {
  const dialog = page.locator(".cmp-dialog");

  // Strategy A — invoke the patched widget.onPointerDown directly. Wrap
  // in its own try: a native combo handler that throws on the synthetic
  // pointer must not abort the run — fall back to Strategy B instead.
  console.log("Opening modal via widget.onPointerDown (Strategy A)…");
  try {
    await page.evaluate(() => {
      const node = window.app.graph._nodes.find(
        (n) => n.type === "LoadImage" && n._galleryPickerEnhanced === true,
      );
      if (!node) throw new Error("Enhanced LoadImage node not found");
      const widget = node.widgets.find((w) => w.name === "image");
      widget.onPointerDown({}, node, window.app.canvas);
    });
    await dialog.waitFor({ state: "visible", timeout: 4_000 });
    return dialog;
  } catch {
    // Strategy B — guaranteed click path via the 📁 Browse button widget.
    console.log("Strategy A did not open the modal; using 📁 Browse button (Strategy B)…");
    // Dismiss any LiteGraph context menu Strategy A may have opened so it
    // doesn't overlay the screenshot.
    await page.evaluate(() => {
      for (const el of document.querySelectorAll(".litecontextmenu, .litegraph.litecontextmenu")) {
        el.remove();
      }
    });
    await page.evaluate(() => {
      const node = window.app.graph._nodes.find(
        (n) => n.type === "LoadImage" && n._galleryPickerEnhanced === true,
      );
      const btn = node.widgets.find(
        (w) => w.type === "button" && /Browse gallery/i.test(w.name || w.label || ""),
      );
      if (!btn) throw new Error("Browse gallery button widget not found");
      btn.callback?.();
    });
    await dialog.waitFor({ state: "visible", timeout: 6_000 });
    return dialog;
  }
}

async function capturePicker(page) {
  console.log("Locating enhanced LoadImage node…");
  // Wait until the pack has patched the LoadImage node.
  await page.waitForFunction(
    () =>
      window.app.graph._nodes.some(
        (n) => n.type === "LoadImage" && n._galleryPickerEnhanced === true,
      ),
    null,
    { timeout: 15_000 },
  );

  // Force a canvas redraw so widget.last_y and friends are populated.
  await page.evaluate(() => {
    window.app.canvas?.setDirty?.(true, true);
    window.app.canvas?.draw?.(true, true);
  });

  const dialog = await openPickerModal(page);

  // Wait for the grid to load (at least one file card).
  await page.waitForFunction(
    () => document.querySelector(".cmp-dialog .ip-grid .ip-card.is-file"),
    null,
    { timeout: 10_000 },
  );

  if (PICKER_QUERY) {
    const search = dialog.locator(".cmp-search");
    await search.waitFor({ state: "visible", timeout: 5_000 });
    await search.fill(PICKER_QUERY);
    await page.waitForFunction(
      () => document.querySelectorAll(".cmp-dialog .ip-grid .ip-card.is-file").length > 0,
      null,
      { timeout: 5_000 },
    );
  }

  await waitForThumbs(page, ".cmp-dialog .ip-thumb");
  await page.waitForTimeout(500);

  console.log(`Capturing ${OUT_DIR}/picker.png…`);
  await dialog.screenshot({ path: `${OUT_DIR}/picker.png` });

  // Close so nothing lingers.
  await page.keyboard.press("Escape");
}

async function main() {
  const workflow = JSON.parse(await readFile(WORKFLOW_PATH, "utf8"));

  const browser = await chromium.launch({
    args: ["--font-render-hinting=none"],
  });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    deviceScaleFactor: 2,
  });
  const page = await context.newPage();

  page.on("console", (msg) => {
    const t = msg.type();
    if (t === "error" || t === "warning") {
      console.log(`[page:${t}] ${msg.text()}`);
    }
  });

  console.log(`Navigating to ${BASE_URL}…`);
  await page.goto(BASE_URL, { waitUntil: "networkidle" });

  await page.waitForFunction(
    () => window.app && window.app.graph && Array.isArray(window.app.graph._nodes),
    null,
    { timeout: 30_000 },
  );

  console.log("Loading two-node workflow…");
  await page.evaluate((wf) => {
    // clean=true wipes the default workflow so we end with just our nodes.
    window.app.loadGraphData(wf, true);
  }, workflow);

  await page.waitForFunction(() => window.app.graph._nodes.length === 2, null, {
    timeout: 10_000,
  });

  // Close the first-run template browser so it doesn't occlude the grid.
  await dismissStartupDialog(page);

  // Inline grid first, before any modal covers the canvas.
  await captureGallery(page);
  await capturePicker(page);

  await browser.close();
}

main().catch((err) => {
  console.error("capture failed:", err);
  process.exit(1);
});
