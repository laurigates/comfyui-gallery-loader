// The picker's scroll behaviour, measured in a real engine.
//
// WHY THIS SUITE EXISTS. Until now this pack had no scroll restoration at all,
// and `renderGrid` carried a comment saying the one thing it did do — centring
// the currently-loaded image on first paint — had to be skipped in flat view
// because "doing better needs a re-assert loop, which needs a browser test
// suite this pack does not have". This is that suite. Every claim the pack now
// makes about scrolling is asserted here, because the jsdom suite CANNOT fail
// for any of them: jsdom performs no layout, so it accepts `scrollTop = 500` on
// a zero-height scroller and reads it back verbatim, detached or not.
//
// Naming, as in comfyui-image-browser's suite:
//   REGRESSION — fails against the bundle from before this change.
//   LOCK       — passed before and must keep passing.
//
// Both labels were VERIFIED by rebuilding the bundle from the pre-change
// `src/image-picker.ts` and running this file against it: 14 of 16 failed, and
// the two that passed are the two labelled LOCK — the in-place repaint after a
// star click, and first-open centring in folder view. Six tests written as LOCK
// were renamed to REGRESSION on the strength of that run, because they assert
// behaviour that did not exist before rather than behaviour being preserved. A
// label nobody has falsified is a guess.
//
// Chromium only. There is no WebKit here, so iOS momentum scrolling is NOT
// covered by anything in this file; the kit's re-assert loop hardens against a
// reported behaviour that nothing in either pack has measured, and a test
// claiming otherwise would be covering nothing.

import { expect, test } from "@playwright/test";

import {
  closePicker,
  DIR_CARD,
  enterFolder,
  FILE_CARD,
  goUp,
  openPicker,
  report,
  SELECTED_CARD,
  scrollMetrics,
  settleOffset,
  tapWithoutScrolling,
  waitForFileCards,
} from "./harness.js";
import { installScrollProbe, trackThumbs } from "./probe.js";
import { folderSpec } from "./server.mjs";

const BULK = "bulk-400";
const BULK_FILES = folderSpec(BULK).fileCount;
const ROOT_FILES = folderSpec("").fileCount;

// The kit's SCROLL_RESTORE_FRAMES — how many frames a restore re-asserts for.
// Kept here as the number a chain that runs to COMPLETION reaches, so "the
// restore let go early" is asserted against the real budget. It is inlined into
// the bundle, so a kit bump that changes it lands here silently; the tests using
// it also assert that a cancellation happened, which is what keeps them from
// passing vacuously if this drifts.
const RESTORE_FRAMES = 12;

// Renderer slowdown for the gesture tests. The restore window is only ~200 ms
// while `mouse.wheel` / `keyboard.press` are out-of-process CDP round-trips, so
// on a loaded machine the gesture can arrive AFTER the chain has finished — and
// the test then passes having proved nothing. Widening the window is the
// deterministic fix; a sleep or a retry would hide the race instead.
const CPU_THROTTLE = 6;

test.beforeEach(async ({ page }) => {
  await installScrollProbe(page);
  page.on("console", (m) => {
    if (m.type() === "error") process.stdout.write(`[page-error] ${m.text()}\n`);
  });
});

/** The restore chain's frame callbacks: the kit's `restore` arms it, `step` continues it. */
async function restoreFrames(page) {
  // Matched with a regex rather than an exact frame name: the engine reports
  // these as `Object.restore` or `step` depending on how the inlined method was
  // reached, and an exact name that stopped matching would quietly return []
  // rather than fail.
  return page.evaluate(() =>
    window.__GL_PROBE__
      .dump()
      .rafs.filter((r) => r.by.some((f) => /(^|\.)(restore|step)$/.test(f))),
  );
}

/** Park the scroller near the bottom of the current listing, through a real gesture-free seed. */
async function parkNearBottom(page) {
  const before = await scrollMetrics(page);
  const target = Math.floor(before.maxScrollTop / 2);
  const seeded = await page.evaluate((v) => window.__GL_PROBE__.seed(v), target);
  await page.evaluate(() => window.__GL_PROBE__.frames(3));
  return seeded;
}

// ---------------------------------------------------------------------------
// The per-directory memory
// ---------------------------------------------------------------------------

test("REGRESSION A — the parent is restored to where it was left", async ({ page }) => {
  await openPicker(page);
  await waitForFileCards(page, ROOT_FILES);

  const parked = await parkNearBottom(page);
  report("A parked in root", parked);
  expect(parked.immediate).toBeGreaterThan(0); // the root must actually scroll

  await enterFolder(page, BULK, BULK_FILES);
  const child = await settleOffset(page);
  expect(child.scrollTop).toBe(0); // a first visit starts at the top

  await goUp(page, ROOT_FILES);
  const back = await settleOffset(page);
  report("A back in root", back);

  // Before this change the parent came back at 0 every time.
  expect(back.scrollTop).toBe(parked.immediate);
});

test("REGRESSION B — descending again restores the child's own offset", async ({ page }) => {
  await openPicker(page);
  await waitForFileCards(page, ROOT_FILES);
  await enterFolder(page, BULK, BULK_FILES);

  const parked = await parkNearBottom(page);
  report("B parked in child", parked);

  await goUp(page, ROOT_FILES);
  await enterFolder(page, BULK, BULK_FILES);
  const back = await settleOffset(page);
  report("B back in child", back);

  expect(back.scrollTop).toBe(parked.immediate);
  // …and it STAYS there while thumbnails land, rather than drifting back up.
  const later = await settleOffset(page);
  expect(later.scrollTop).toBe(back.scrollTop);
});

test("REGRESSION C — closing at a deep offset and reopening returns to it", async ({ page }) => {
  // The one that used to store 0 with no way to notice: the kit's shell removes
  // the dialog and only THEN calls onClose, so a `bodyEl.scrollTop` read there
  // reports 0 in every real engine. jsdom reports the last assigned value and
  // cannot see this at all.
  await openPicker(page);
  await waitForFileCards(page, ROOT_FILES);
  await enterFolder(page, BULK, BULK_FILES);
  const parked = await parkNearBottom(page);
  report("C parked before close", parked);

  await closePicker(page);
  await page.evaluate(() => window.__GL_E2E__.open({ value: "" }));
  await waitForFileCards(page, ROOT_FILES);
  await enterFolder(page, BULK, BULK_FILES);
  const back = await settleOffset(page);
  report("C after reopen", back);

  expect(back.scrollTop).toBe(parked.immediate);
});

test("REGRESSION D — folder view and flat view keep SEPARATE offsets", async ({ page }) => {
  // Same directory, two different listings: sharing one slot would restore an
  // offset measured against the wrong content height.
  await openPicker(page);
  await waitForFileCards(page, ROOT_FILES);
  await enterFolder(page, BULK, BULK_FILES);
  const folderParked = await parkNearBottom(page);

  await page.locator(".ip-view-toggle").click();
  await expect(page.locator(FILE_CARD).first()).toBeVisible();
  const flatArrived = await settleOffset(page);
  report("D flat on arrival", flatArrived);
  expect(flatArrived.scrollTop).toBe(0); // never visited in this view

  const flatParked = await page.evaluate(
    (v) => window.__GL_PROBE__.seed(v),
    flatArrived.maxScrollTop,
  );
  await page.evaluate(() => window.__GL_PROBE__.frames(3));

  await page.locator(".ip-view-toggle").click();
  await waitForFileCards(page, BULK_FILES);
  const backToFolder = await settleOffset(page);
  report("D back in folder view", backToFolder);
  expect(backToFolder.scrollTop).toBe(folderParked.immediate);

  await page.locator(".ip-view-toggle").click();
  const backToFlat = await settleOffset(page);
  report("D back in flat view", backToFlat);
  expect(backToFlat.scrollTop).toBe(flatParked.immediate);
  // The two arms must differ, or "each keeps its own" is unfalsifiable here.
  expect(flatParked.immediate).not.toBe(folderParked.immediate);
});

// ---------------------------------------------------------------------------
// The restore itself
// ---------------------------------------------------------------------------

test("REGRESSION E — a late mover inside the restore window is corrected", async ({ page }) => {
  // A single synchronous assignment has no answer to anything that moves the
  // scroller a frame or two later. The knock is programmatic (not a gesture),
  // which is exactly the case the re-assert loop is supposed to win.
  await openPicker(page);
  await waitForFileCards(page, ROOT_FILES);
  await enterFolder(page, BULK, BULK_FILES);
  const parked = await parkNearBottom(page);
  await goUp(page, ROOT_FILES);

  await page.evaluate(() => window.__GL_PROBE__.armKnock(0, 2));
  await enterFolder(page, BULK, BULK_FILES);
  const knock = await page.evaluate(() => window.__GL_PROBE__.knockRecord());
  const after = await settleOffset(page);
  report("E knock", knock);
  report("E after", after);

  expect(knock?.fired).toBe(true); // the hostile move really happened
  expect(after.scrollTop).toBe(parked.immediate); // and was corrected
});

test("REGRESSION F — a wheel gesture inside the restore window wins", async ({ page }) => {
  await openPicker(page);
  await waitForFileCards(page, ROOT_FILES);
  await enterFolder(page, BULK, BULK_FILES);
  const parked = await parkNearBottom(page);
  const remembered = parked.immediate;
  await goUp(page, ROOT_FILES);

  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: CPU_THROTTLE });
  await tapWithoutScrolling(page, `${DIR_CARD}[data-name="${BULK}"]`);
  await page.mouse.move(195, 500);
  await page.mouse.wheel(0, -4000);
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: 1 });

  const after = await settleOffset(page);
  const stable = await settleOffset(page);
  const rafs = await restoreFrames(page);
  report("F restore frame callbacks", {
    scheduled: rafs.length,
    ran: rafs.filter((r) => r.ranAt !== null).length,
    cancelled: rafs.filter((r) => r.cancelledAt !== null).length,
  });
  report("F after wheel", after);

  // The wheel landed while the chain was live — the cancel it provoked is in
  // the ledger. Without this the test could pass by arriving after the window
  // closed, with nothing to fight and nothing proven.
  expect(rafs.filter((r) => r.cancelledAt !== null).length).toBeGreaterThanOrEqual(1);
  expect(rafs.filter((r) => r.ranAt !== null).length).toBeLessThan(RESTORE_FRAMES);
  // The gesture, not the remembered offset, decides where the view sits.
  expect(after.scrollTop).toBeLessThan(remembered - 200);
  expect(stable.scrollTop).toBe(after.scrollTop);
});

test("REGRESSION G — a keyboard scroll inside the restore window is not swallowed", async ({
  page,
}) => {
  // Keyboard scrolling produces NO pointerdown/wheel/touchstart, so a guard
  // watching only those lets the loop fight the key — and the loop wins, which
  // is worse than a delay: the keypress does nothing at all (measured in
  // comfyui-image-browser at 8 samples over ~360 ms with the offset pinned).
  //
  // WHAT THIS TEST CAN AND CANNOT SEE HERE. This pack's modal is NOT
  // full-viewport (min(1100px, 100vw - 16px) × min(88vh, 820px)), so with focus
  // on <body> Chromium routes End to the PAGE behind the dialog, not to
  // `.cmp-body`. So the assertion is on the guard itself — the restore chain
  // stands down mid-flight — plus the page having moved, which proves the key
  // was delivered rather than eaten. comfyui-image-browser's suite, whose modal
  // IS the viewport, asserts the offset directly; that half genuinely does not
  // exist here and a test claiming it would be claiming the harness.
  await openPicker(page);
  await waitForFileCards(page, ROOT_FILES);
  await enterFolder(page, BULK, BULK_FILES);
  const parked = await parkNearBottom(page);
  await goUp(page, ROOT_FILES);

  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: CPU_THROTTLE });
  await tapWithoutScrolling(page, `${DIR_CARD}[data-name="${BULK}"]`);
  // Out of the search field first: the shell autofocuses it, and there End
  // moves the caret rather than the view — which is exactly why the kit's
  // isTypingTarget default exists (and what the LOCK below pins).
  await page.evaluate(() => document.activeElement?.blur?.());
  await page.keyboard.press("End");
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: 1 });

  const after = await settleOffset(page);
  const pageScroll = await page.evaluate(() => document.scrollingElement.scrollTop);
  const rafs = await restoreFrames(page);
  report("G restore frame callbacks", {
    scheduled: rafs.length,
    ran: rafs.filter((r) => r.ranAt !== null).length,
    cancelled: rafs.filter((r) => r.cancelledAt !== null).length,
  });
  report("G after End", { modal: after.scrollTop, page: pageScroll });

  // The key landed while the chain was live and ended it. Without this the test
  // could pass by arriving after the window closed, with nothing to fight.
  expect(rafs.filter((r) => r.cancelledAt !== null).length).toBeGreaterThanOrEqual(1);
  expect(rafs.filter((r) => r.ranAt !== null).length).toBeLessThan(RESTORE_FRAMES);
  // …and the key was delivered somewhere rather than swallowed.
  expect(pageScroll).toBeGreaterThan(0);
  expect(parked.immediate).toBeGreaterThan(0);
});

test("REGRESSION I — typing in the search field does not disarm the restore", async ({ page }) => {
  // The paired positive for G. The shell autofocuses the search input, so if a
  // caret key counted as a scroll gesture the restore would be dropped on every
  // keystroke of a filter — and the folder you came back to would be at the top.
  await openPicker(page);
  await waitForFileCards(page, ROOT_FILES);
  await enterFolder(page, BULK, BULK_FILES);
  const parked = await parkNearBottom(page);
  await goUp(page, ROOT_FILES);

  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: CPU_THROTTLE });
  await tapWithoutScrolling(page, `${DIR_CARD}[data-name="${BULK}"]`);
  await page.locator(".cmp-search").press("ArrowDown");
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: 1 });

  const after = await settleOffset(page);
  report("typing-in-field after", after);
  expect(after.scrollTop).toBe(parked.immediate);
});

test("REGRESSION J — a new search or sort starts at the top and stays there", async ({ page }) => {
  await openPicker(page);
  await waitForFileCards(page, ROOT_FILES);
  await enterFolder(page, BULK, BULK_FILES);
  await parkNearBottom(page);

  await page.locator(".cmp-search").fill("img-01");
  const afterSearch = await settleOffset(page);
  report("after search", afterSearch);
  expect(afterSearch.scrollTop).toBe(0);

  await page.locator(".cmp-search").fill("");
  await waitForFileCards(page, BULK_FILES);
  await parkNearBottom(page);
  await page.locator("select.ip-control").selectOption("name:asc");
  const afterSort = await settleOffset(page);
  report("after sort", afterSort);
  expect(afterSort.scrollTop).toBe(0);
});

test("LOCK — an in-place re-render (a star click) keeps the offset", async ({ page }) => {
  await openPicker(page);
  await waitForFileCards(page, ROOT_FILES);
  await enterFolder(page, BULK, BULK_FILES);
  const parked = await parkNearBottom(page);

  const card = page.locator(FILE_CARD).nth(30);
  await card.scrollIntoViewIfNeeded();
  const before = await scrollMetrics(page);
  await card.locator(".ip-star").nth(3).click();
  const after = await settleOffset(page);
  report("star — before/after", { before: before.scrollTop, after: after.scrollTop });

  expect(after.scrollTop).toBe(before.scrollTop);
  expect(after.scrollTop).toBeGreaterThan(0);
  expect(parked.immediate).toBeGreaterThan(0);
});

test("REGRESSION K — an unreachable offset settles at the bottom instead of fighting", async ({
  page,
}) => {
  // The folder got shorter while you were away — files deleted from another
  // tab, or by the other pack. The restore must give up at the new bottom
  // rather than re-asserting an offset that no longer exists.
  //
  // The shrink is done by rewriting the LISTING for the return trip, not with a
  // search box: a new search resets to the top by design, so a search-based
  // version of this test would settle at 0 and its `<= maxScrollTop` assertion
  // would pass without ever exercising the clamp. (It did exactly that here
  // before this was rewritten — 0 against a max of 2565.)
  const SHRUNK_TO = 40;
  await openPicker(page);
  await waitForFileCards(page, ROOT_FILES);
  await enterFolder(page, BULK, BULK_FILES);
  await settleOffset(page);
  const deep = await scrollMetrics(page);
  const parked = await page.evaluate((v) => window.__GL_PROBE__.seed(v), deep.maxScrollTop - 500);
  await settleOffset(page);
  await goUp(page, ROOT_FILES);

  await page.route("**/gallery_loader/list*", async (route) => {
    const res = await route.fetch();
    const body = await res.json();
    if (Array.isArray(body.files) && body.files.length > SHRUNK_TO) {
      body.files = body.files.slice(0, SHRUNK_TO);
    }
    await route.fulfill({ response: res, json: body });
  });

  await enterFolder(page, BULK, SHRUNK_TO);
  const after = await settleOffset(page);
  const stable = await settleOffset(page);
  report("shrink — parked at", parked);
  report("shrink — after", after);

  // The target is genuinely out of reach now…
  expect(parked.immediate).toBeGreaterThan(after.maxScrollTop);
  // …so the view sits at the new bottom, exactly — not at 0, and not fighting.
  expect(after.scrollTop).toBe(after.maxScrollTop);
  expect(after.maxScrollTop).toBeGreaterThan(0);
  expect(stable.scrollTop).toBe(after.scrollTop);
});

test("REGRESSION L — closing during an active restore leaves nothing scheduled", async ({
  page,
}) => {
  // Nothing scheduled may outlive the modal — the same rule the lazy-media
  // observer follows. A leaked frame callback performs no writes (it early-
  // returns on a detached host), so the SCHEDULE itself has to be observed.
  await openPicker(page);
  await waitForFileCards(page, ROOT_FILES);
  await enterFolder(page, BULK, BULK_FILES);
  await parkNearBottom(page);
  await goUp(page, ROOT_FILES);

  await tapWithoutScrolling(page, `${DIR_CARD}[data-name="${BULK}"]`);
  await closePicker(page);
  const atClose = await page.evaluate(() => window.__GL_PROBE__.dump().sets.length);
  await page.evaluate(() => window.__GL_PROBE__.frames(30));
  const afterFrames = await page.evaluate(() => window.__GL_PROBE__.dump().sets.length);
  const rafs = await restoreFrames(page);
  report("leak — writes at close vs after 30 frames", { atClose, afterFrames });
  report("leak — restore frame callbacks", rafs);

  expect(afterFrames).toBe(atClose);
  // Every scheduled frame either ran while the dialog was up, or was cancelled.
  for (const r of rafs) {
    expect(r.ranAt === null || r.ranWithDialog === true).toBe(true);
  }
});

// ---------------------------------------------------------------------------
// First-open centring — the behaviour that predates this change
// ---------------------------------------------------------------------------

test("LOCK — first open centres the widget's current image", async ({ page }) => {
  const name = "img-0200.png";
  await openPicker(page, { value: `${BULK}/${name}` });
  await waitForFileCards(page, BULK_FILES);
  const settled = await settleOffset(page);
  const box = await page.locator(SELECTED_CARD).boundingBox();
  const viewport = page.viewportSize();
  report("centre — settled", settled);
  report("centre — selected card box", box);

  expect(settled.scrollTop).toBeGreaterThan(0);
  // The card is on screen, and roughly centred rather than merely scrolled to.
  expect(box).not.toBeNull();
  expect(box.y).toBeGreaterThan(0);
  expect(box.y + box.height).toBeLessThan(viewport.height);
});

test("REGRESSION H — first-open centring now works in FLAT view too", async ({ page }) => {
  // This was skipped outright before: with thousands of cards the single bare
  // write landed against a shorter-than-final layout and was CLAMPED, leaving
  // the view somewhere arbitrary. The re-assert loop is what makes it safe, so
  // the assertion is that the selected card is actually on screen.
  await openPicker(page, {
    value: `${BULK}/img-0200.png`,
    storage: { "comfyui-gallery-loader:view": "flat" },
  });
  await expect(page.locator(FILE_CARD).first()).toBeVisible();
  const settled = await settleOffset(page);
  const box = await page.locator(SELECTED_CARD).boundingBox();
  const viewport = page.viewportSize();
  report("flat centre — settled", settled);
  report("flat centre — selected card box", box);

  expect(settled.scrollTop).toBeGreaterThan(0);
  expect(box).not.toBeNull();
  expect(box.y).toBeGreaterThan(0);
  expect(box.y + box.height).toBeLessThan(viewport.height);
});

test("REGRESSION O — a remembered offset beats the centring on REOPEN", async ({ page }) => {
  // The `didInitialScroll` branch runs once per modal, so the return-visit case
  // below cannot reach it — a mutation removing the "only when nothing is
  // remembered" guard survived that test and was reported MISSED by
  // `just mutation-check comfyui-gallery-loader tests/mutations-e2e.json`.
  // The case the guard actually protects is a REOPEN: the scroll memory is
  // module-level and outlives the modal, so on the second open the folder has
  // both a remembered offset and a selected card, and they disagree.
  const value = `${BULK}/img-0200.png`;
  await openPicker(page, { value });
  await waitForFileCards(page, BULK_FILES);
  const centred = await settleOffset(page);

  const parked = await page.evaluate((v) => window.__GL_PROBE__.seed(v), 40000);
  await settleOffset(page);
  await closePicker(page);

  await page.evaluate((v) => window.__GL_E2E__.open({ value: v }), value);
  await waitForFileCards(page, BULK_FILES);
  const reopened = await settleOffset(page);
  report("reopen — centred vs parked vs reopened", {
    centred: centred.scrollTop,
    parked: parked.immediate,
    reopened: reopened.scrollTop,
  });

  expect(reopened.scrollTop).toBe(parked.immediate);
  // The two must differ, or this cannot tell "remembered" from "re-centred".
  expect(parked.immediate).not.toBe(centred.scrollTop);
});

test("REGRESSION M — a remembered offset beats the centring on a RETURN visit", async ({
  page,
}) => {
  // Centring is a first-open affordance. Coming back to a folder you scrolled
  // must resume there, not re-centre on the selected card.
  await openPicker(page, { value: `${BULK}/img-0200.png` });
  await waitForFileCards(page, BULK_FILES);
  const centred = await settleOffset(page);

  const parked = await page.evaluate((v) => window.__GL_PROBE__.seed(v), 40000);
  await page.evaluate(() => window.__GL_PROBE__.frames(3));
  await goUp(page, ROOT_FILES);
  await enterFolder(page, BULK, BULK_FILES);
  const back = await settleOffset(page);
  report("return — centred vs parked vs back", {
    centred: centred.scrollTop,
    parked: parked.immediate,
    back: back.scrollTop,
  });

  expect(back.scrollTop).toBe(parked.immediate);
  // The two must differ, or this cannot tell "remembered" from "re-centred".
  expect(parked.immediate).not.toBe(centred.scrollTop);
});

// ---------------------------------------------------------------------------
// The lazy-thumb ordering the restore depends on
// ---------------------------------------------------------------------------

test("REGRESSION N — only the restored band's thumbnails are fetched", async ({ page }) => {
  // Restoring BEFORE installing the observer is what makes this true: observing
  // first computes the first pass against the pre-restore viewport and queues
  // the top-of-list band, which in a flat listing is thousands of wrong
  // requests.
  const thumbs = trackThumbs(page);
  await openPicker(page);
  await waitForFileCards(page, ROOT_FILES);
  await enterFolder(page, BULK, BULK_FILES);
  const parked = await parkNearBottom(page);
  await goUp(page, ROOT_FILES);

  // Settle first: the ROOT's own thumbnails are still arriving after goUp, and
  // its files are named img-0001… too — so a cut taken too early samples the
  // parent's band as if it were the child's (observed: idx 0 among the results).
  // The subfolder filter is the real discriminator; the settle just keeps the
  // count honest.
  await settleOffset(page);
  const cut = thumbs.cut();
  await enterFolder(page, BULK, BULK_FILES);
  await settleOffset(page);
  const fetched = thumbs.since(cut).filter((r) => r.idx !== null && r.subfolder === BULK);
  const idxs = fetched.map((r) => r.idx).sort((a, b) => a - b);
  report("bands — restored to", parked.immediate);
  report("bands — fetched", { count: idxs.length, first: idxs[0], last: idxs[idxs.length - 1] });

  expect(idxs.length).toBeGreaterThan(0);
  // A small band around the restored offset, not the whole 400-file listing.
  expect(idxs.length).toBeLessThan(BULK_FILES / 4);
  expect(idxs[0]).toBeGreaterThan(20);
});
