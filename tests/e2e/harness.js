// Shared drivers for the Playwright (browser) suite.
//
// Everything here is about ONE thing the jsdom suite structurally cannot do:
// jsdom performs no layout, so `scrollTop = N` is stored verbatim and read back
// verbatim. A real engine CLAMPS the assignment to `scrollHeight - clientHeight`
// at the instant of assignment. Helpers therefore never report a scroll offset
// on its own — they report it next to the clamp bound that produced it, because
// "the offset is 0" and "the offset was clamped to 0" are different bugs.
//
// A PORT of comfyui-image-browser/tests/e2e/harness.js, retargeted at the
// picker's selectors and its widget-driven open path.

import { expect } from "@playwright/test";

// The scrolling ancestor is the modal shell's body, NOT `.ip-grid` (which has
// no overflow clip). This is the same invariant the lazy-thumb observer root
// depends on — see the hard rule in CLAUDE.md.
const SCROLLER = ".cmp-body";
const GRID = ".ip-grid";
// The picker uses the kit's plain dialog (no pack-specific dialog class), which
// is also why it is NOT full-viewport here.
const DIALOG = ".cmp-dialog";
export const FILE_CARD = ".ip-card.is-file";
export const DIR_CARD = ".ip-card.is-dir";
const UP_CARD = ".ip-card.is-up";
export const SELECTED_CARD = ".ip-card.is-selected";

/**
 * Load the fixture and open the picker through the bundle's exported
 * `openImagePicker()`, driven by a stub widget.
 *
 * `storage` is applied BEFORE the modal mounts: the saved sort and view mode
 * are read at open time, so seeding them afterwards would have no effect on the
 * render under test.
 *
 * `value` is the widget's current value — the picker parses it for the initial
 * root/subfolder and for which card is `is-selected`.
 */
export async function openPicker(page, { storage, value = "", mode = "file" } = {}) {
  await page.goto("/");
  await page.waitForFunction(() => window.__GL_E2E_READY__ === true);
  if (storage) {
    await page.evaluate((entries) => {
      for (const [k, v] of Object.entries(entries)) localStorage.setItem(k, v);
    }, storage);
  }
  await page.evaluate((opts) => window.__GL_E2E__.open(opts), { value, mode });
  await expect(page.locator(DIALOG)).toBeVisible();
  await page.locator(GRID).waitFor();
}

/** Close the picker the way a user does, and wait for the shell to detach. */
export async function closePicker(page) {
  await page.keyboard.press("Escape");
  await expect(page.locator(DIALOG)).toHaveCount(0);
}

/** Wait until the grid has settled on `count` file cards. */
export async function waitForFileCards(page, count) {
  await expect(page.locator(FILE_CARD)).toHaveCount(count, { timeout: 20_000 });
}

/**
 * Tap a card by dispatching the click IN the page instead of through
 * Playwright's pointer.
 *
 * Playwright scrolls a target into view before clicking it, and folder / `..`
 * cards sit at the TOP of the grid — so at a deep offset the harness moves the
 * scroller to ~0 BEFORE `rememberScroll()` runs, erasing the number under test
 * and then "discovering" it was lost. Measured here on the first run: five
 * tests failed with a remembered 0 against a parked 743, and the read the probe
 * logged came from a connected, rendered element that really was at 0.
 * `el.click()` reaches the same delegated `gridEl` handler with the same event
 * shape and moves nothing.
 *
 * The equality assertion is a guard, not a formality: if this ever starts
 * moving the scroller, every measurement downstream becomes meaningless.
 * (Inherited, with the trap, from comfyui-image-browser's suite.)
 */
export async function tapWithoutScrolling(page, selector) {
  const hit = await page.evaluate(
    ({ sel, scroller }) => {
      const el = document.querySelector(sel);
      if (!el) return null;
      const host = document.querySelector(scroller);
      const before = host.scrollTop;
      el.click();
      return { before, after: host.scrollTop };
    },
    { sel: selector, scroller: SCROLLER },
  );
  expect(hit).not.toBeNull();
  expect(hit.after).toBe(hit.before);
  return hit;
}

/** Tap a folder card and wait for the new listing to paint. */
export async function enterFolder(page, name, expectedFileCount) {
  await tapWithoutScrolling(page, `${DIR_CARD}[data-name="${name}"]`);
  await waitForFileCards(page, expectedFileCount);
}

/** Tap the `..` card and wait for the parent listing to paint. */
export async function goUp(page, expectedFileCount) {
  await tapWithoutScrolling(page, UP_CARD);
  await waitForFileCards(page, expectedFileCount);
}

/**
 * One snapshot of the scroller's geometry.
 *
 * `maxScrollTop` is the clamp bound: any assignment above it silently becomes
 * it. Reporting the pair is the whole point — a restore that "failed" because
 * the content had not grown tall enough yet is a different defect from a
 * restore that was overwritten after the fact.
 */
export async function scrollMetrics(page) {
  return page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    return {
      scrollTop: el.scrollTop,
      scrollHeight: el.scrollHeight,
      clientHeight: el.clientHeight,
      maxScrollTop: Math.max(0, el.scrollHeight - el.clientHeight),
      overflowY: getComputedStyle(el).overflowY,
    };
  }, SCROLLER);
}

/** Sample until the offset stops changing, then report it with its clamp bound. */
export async function settleOffset(page, frames = 40) {
  await page.evaluate((n) => window.__GL_PROBE__.frames(n), frames);
  return scrollMetrics(page);
}

/** Print a labelled measurement into the run log — evidence, not decoration. */
export function report(label, value) {
  process.stdout.write(`[scroll] ${label}: ${JSON.stringify(value)}\n`);
}
