// The lazy-thumbnail CONSEQUENCE, measured in a real engine (#86 §2).
//
// tests/js/image-picker.test.js asserts WHICH element the IntersectionObserver
// is rooted on. That is a structural check: it would still pass if the root
// were right and the behaviour wrong (a rootMargin of thousands of pixels, an
// observer installed before the cards exist, a selector that matches nothing).
// jsdom cannot measure the behaviour — it performs no layout, so nothing in it
// ever intersects anything. This file measures what the user pays for: how
// many thumbnails a 400-card folder actually loads, and which ones.
//
// comfyui-image-browser recorded the number this is about: 400/400 off-screen
// cards intersect with the grid as root, 20/400 with the real scroller. The
// PREMISE test below re-measures that split on THIS fixture, so the two
// consequence tests are known to be able to tell a grid-rooted observer from a
// correct one here — not assumed to from another pack's layout.
//
// Chromium only, at the 390x844 phone viewport the config pins.

import { expect, test } from "@playwright/test";

import { FILE_CARD, openPicker, report, settleOffset, waitForFileCards } from "./harness.js";
import { installScrollProbe, trackThumbs } from "./probe.js";
import { folderSpec } from "./server.mjs";

const BULK = "bulk-400";
const BULK_FILES = folderSpec(BULK).fileCount;
// The picker's own rootMargin (installLazyThumbs in src/image-picker.ts). The
// band a correct observer loads is the viewport grown by this much each way.
const ROOT_MARGIN = 300;

test.beforeEach(async ({ page }) => {
  await installScrollProbe(page);
});

/** Open straight into the bulk folder, at the top (the value names no file). */
async function openBulkAtTop(page) {
  await openPicker(page, { value: `${BULK}/not-a-listed-file.png` });
  await waitForFileCards(page, BULK_FILES);
  await settleOffset(page);
}

/**
 * Per-card load state, with each card's position relative to the scroller's
 * visible box. `loaded` = the kit promoted data-src to src.
 */
async function cardStates(page) {
  return page.evaluate(
    ({ sel }) => {
      const host = document.querySelector(".cmp-body").getBoundingClientRect();
      return [...document.querySelectorAll(sel)].map((card, i) => {
        const img = card.querySelector("img");
        const r = card.getBoundingClientRect();
        return {
          i,
          loaded: !!img && img.hasAttribute("src") && !img.hasAttribute("data-src"),
          // Distance outside the scroller's visible box, 0 when inside it.
          outside: Math.max(0, host.top - r.bottom, r.top - host.bottom),
        };
      });
    },
    { sel: FILE_CARD },
  );
}

test("PREMISE — on this fixture a grid-rooted observer sees every card, the scroller a band", async ({
  page,
}) => {
  await openBulkAtTop(page);
  const counts = await page.evaluate(async (margin) => {
    const cards = [...document.querySelectorAll(".ip-card.is-file")];
    const count = (root) =>
      new Promise((resolve) => {
        const io = new IntersectionObserver(
          (entries) => {
            io.disconnect();
            resolve(entries.filter((e) => e.isIntersecting).length);
          },
          { root, rootMargin: `${margin}px` },
        );
        for (const c of cards) io.observe(c);
      });
    return {
      cards: cards.length,
      grid: await count(document.querySelector(".ip-grid")),
      scroller: await count(document.querySelector(".cmp-body")),
    };
  }, ROOT_MARGIN);
  report("premise — intersecting on first callback", counts);

  expect(counts.cards).toBe(BULK_FILES);
  expect(counts.grid).toBe(BULK_FILES);
  expect(counts.scroller).toBeGreaterThan(0);
  expect(counts.scroller).toBeLessThan(BULK_FILES / 4);
});

test("REGRESSION — first paint of a 400-card folder loads only the band on screen", async ({
  page,
}) => {
  const thumbs = trackThumbs(page);
  await openBulkAtTop(page);
  const states = await cardStates(page);
  const loaded = states.filter((s) => s.loaded);
  const fetched = thumbs.all.filter((r) => r.subfolder === BULK && r.idx !== null);
  report("first paint — loaded / fetched / cards", {
    loaded: loaded.length,
    fetched: fetched.length,
    cards: states.length,
    lastLoaded: loaded.at(-1)?.i,
  });

  // Something loads: an observer that never fires would pass the cap below.
  expect(loaded.length).toBeGreaterThan(0);
  expect(states[0].loaded).toBe(true);
  // …but a band, not the listing.
  expect(loaded.length).toBeLessThan(BULK_FILES / 4);
  expect(fetched.length).toBeLessThan(BULK_FILES / 4);
  // And the RIGHT band: every loaded card sits within the root margin of the
  // visible box. One card of slack covers a row straddling the margin edge.
  const cardHeight = await page
    .locator(FILE_CARD)
    .first()
    .evaluate((el) => el.offsetHeight);
  for (const s of loaded) expect(s.outside).toBeLessThanOrEqual(ROOT_MARGIN + cardHeight);
});

test("REGRESSION — scrolling to the bottom loads the bottom band and skips the middle", async ({
  page,
}) => {
  // The acceptance half: lazy, not merely "loads little". Jumping straight to
  // the bottom must load the last cards and leave the ones scrolled past
  // unrequested.
  const thumbs = trackThumbs(page);
  await openBulkAtTop(page);
  await page.evaluate(() => {
    const el = document.querySelector(".cmp-body");
    window.__GL_PROBE__.seed(el.scrollHeight);
  });
  await settleOffset(page, 20);
  const states = await cardStates(page);
  const loaded = states.filter((s) => s.loaded);
  const fetchedIdx = new Set(
    thumbs.all.filter((r) => r.subfolder === BULK && r.idx !== null).map((r) => r.idx),
  );
  report("bottom — loaded / fetched", { loaded: loaded.length, fetched: fetchedIdx.size });

  expect(states.at(-1).loaded).toBe(true);
  expect(fetchedIdx.has(BULK_FILES - 1)).toBe(true);
  // The middle of the listing was never on screen, so never requested.
  const mid = Math.floor(BULK_FILES / 2);
  expect(states[mid].loaded).toBe(false);
  expect(fetchedIdx.has(mid)).toBe(false);
  // Top band + bottom band, still far short of the whole folder.
  expect(loaded.length).toBeLessThan(BULK_FILES / 2);
});
