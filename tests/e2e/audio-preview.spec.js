// Audio preview (issue #116) in a real engine.
//
// The jsdom suite (tests/js/video-loaders.test.js) owns the contract — which
// element is asked to play which URL, the commit handler's skip list, the
// teardown calls — but jsdom has no media pipeline, so it spies on play() and
// can never see sound start. This file answers the half only a browser can:
// a real tap on ▶ (a genuine user activation, which Chromium's autoplay policy
// requires) starts real playback from the URL the card built, a second take
// takes over the SAME element, and closing the picker leaves it paused with no
// source.
//
// `audio-<N>` folders are served by tests/e2e/server.mjs as N real WAV takes.

import { expect, test } from "@playwright/test";
import { FILE_CARD, openPicker, waitForFileCards } from "./harness.js";

const playBtn = (page, name) => page.locator(`${FILE_CARD}[data-name="${name}"] .ip-play`);

/** The modal's preview element's live state, read in the page. */
function previewState(page) {
  return page.evaluate(() => {
    const els = document.querySelectorAll(".cmp-dialog audio");
    const el = els[0];
    return {
      count: els.length,
      src: el?.getAttribute("src") ?? null,
      paused: el ? el.paused : null,
      currentTime: el ? el.currentTime : null,
    };
  });
}

async function waitPlaying(page, srcPart) {
  await expect
    .poll(async () => {
      const s = await previewState(page);
      return s.src?.includes(srcPart) && s.paused === false && s.currentTime > 0;
    })
    .toBe(true);
}

test("▶ plays a sandboxed take in place; a second take takes over the one element", async ({
  page,
}) => {
  await openPicker(page, { value: "audio-2/take-0001.wav [output]" });
  await waitForFileCards(page, 2);

  await playBtn(page, "take-0001.wav").click();
  await waitPlaying(page, "/api/view?filename=take-0001.wav&type=output&subfolder=audio-2");
  // The tap previewed; it did not select, and the picker is still up.
  await expect(page.locator(".cmp-dialog")).toBeVisible();
  expect(await page.evaluate(() => window.__GL_E2E__.committed())).toBeNull();
  await expect(playBtn(page, "take-0001.wav")).toHaveAttribute("aria-pressed", "true");

  const first = await page.locator(".cmp-dialog audio").elementHandle();
  await playBtn(page, "take-0002.wav").click();
  await waitPlaying(page, "filename=take-0002.wav");
  const s = await previewState(page);
  expect(s.count).toBe(1);
  // Identity, not a count: a rebuilt element would also leave exactly one.
  expect(await first.evaluate((el) => el === document.querySelector(".cmp-dialog audio"))).toBe(
    true,
  );
  await expect(playBtn(page, "take-0001.wav")).toHaveAttribute("aria-pressed", "false");
  await expect(playBtn(page, "take-0002.wav")).toHaveAttribute("aria-pressed", "true");

  // Tapping the playing take's button stops it.
  await playBtn(page, "take-0002.wav").click();
  expect(await first.evaluate((el) => el.paused)).toBe(true);
  await expect(playBtn(page, "take-0002.wav")).toHaveAttribute("aria-pressed", "false");
});

test("closing the picker mid-take stops playback and drops the source", async ({ page }) => {
  await openPicker(page, { value: "audio-2/take-0001.wav [output]" });
  await waitForFileCards(page, 2);

  await playBtn(page, "take-0001.wav").click();
  await waitPlaying(page, "filename=take-0001.wav");
  const el = await page.locator(".cmp-dialog audio").elementHandle();

  await page.keyboard.press("Escape");
  await expect(page.locator(".cmp-dialog")).toHaveCount(0);
  const after = await el.evaluate((a) => ({ paused: a.paused, src: a.getAttribute("src") }));
  expect(after).toEqual({ paused: true, src: null });
});

test("path mode streams the take through /gallery_loader/file", async ({ page }) => {
  await openPicker(page, {
    kind: "vhs-path",
    value: "/fixture/comfy/audio-1/take-0001.wav",
  });
  await waitForFileCards(page, 1);

  await playBtn(page, "take-0001.wav").click();
  await waitPlaying(page, "/gallery_loader/file?path=");
  const s = await previewState(page);
  expect(decodeURIComponent(s.src)).toContain("/fixture/comfy/audio-1/take-0001.wav");
  expect(await page.evaluate(() => window.__GL_E2E__.committed())).toBeNull();
});
