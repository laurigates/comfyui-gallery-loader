// Playwright config for the BROWSER suite — deliberately separate from
// vitest.config.js.
//
// A PORT of comfyui-image-browser/tests/e2e/playwright.config.js, including its
// port-collision and pre-installed-Chromium handling. The default port differs
// (8299, not 8199) so the two packs' suites can run side by side on one
// machine without one attaching to the other's fixture server.
//
// The two suites are different environments answering different questions and
// must stay separately runnable:
//   `bun run test`     → vitest/jsdom, tests/js/**, no layout engine
//   `bun run test:e2e` → this config, tests/e2e/**, real Chromium with layout
// vitest's `include` is scoped to `tests/js/**/*.test.js` and this config's
// testMatch is scoped to `*.spec.js`, so neither runner can pick up the other's
// files even by accident.

import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig } from "@playwright/test";
import { DEFAULT_PORT } from "./server.mjs";

// ---- Port -------------------------------------------------------------
//
// A FIXED port plus `reuseExistingServer` is a trap for concurrent runs on one
// checkout: the second run finds the first run's server, attaches to it instead
// of starting its own, and then the first run finishes and tears it down —
// leaving the second with a cascade of `net::ERR_CONNECTION_REFUSED` that reads
// as a product regression rather than as a harness collision (observed: five
// passes, two 20-second `toHaveCount` timeouts, then twenty instant failures).
// So each run picks its OWN port unless one is named explicitly.
//
// `GL_E2E_PORT` is written back into the environment because Playwright
// re-imports this config in every worker process: without the write-back each
// process would derive its own port from its own pid and the workers would
// address a server that is not there. Setting it explicitly is also how you opt
// INTO sharing a server (`GL_E2E_PORT=8299 bun run test:e2e` in one shell, then
// another) — that is the case `reuseExistingServer` exists for.
function resolvePort() {
  if (process.env.GL_E2E_PORT) return Number(process.env.GL_E2E_PORT);
  // A CI job owns its runner, so the documented default is the friendlier
  // choice there; locally, spread across the ephemeral range by pid.
  if (process.env.CI) return DEFAULT_PORT;
  return 20000 + (process.pid % 40000);
}

const PORT = resolvePort();
process.env.GL_E2E_PORT = String(PORT);
const BASE_URL = `http://127.0.0.1:${PORT}`;

// ---- Browser binary resolution -----------------------------------------
//
// This environment has Chromium PRE-INSTALLED under PLAYWRIGHT_BROWSERS_PATH at
// build revision 1194 (Chromium 141.0.7390.37) and NO network path to download
// another one — `playwright install` must never run. Playwright resolves its
// browser by revision, so the @playwright/test version is load-bearing: it is
// pinned (exact, no caret) to the release whose expected chromium revision is
// the one on disk. If a dependency bump ever breaks that match we point
// executablePath at the binary we have rather than let Playwright try to fetch
// one — a download attempt fails slowly and confusingly, an explicit path fails
// immediately and legibly.
const PW_ROOT = process.env.PLAYWRIGHT_BROWSERS_PATH || "";
const PREINSTALLED_CHROMIUM = "/opt/pw-browsers/chromium";

function chromiumOverride() {
  if (!PW_ROOT) return {};
  let want;
  try {
    // playwright-core's browsers.json is the authority on the revision this
    // Playwright will look for — asking it beats hard-coding 1194 in a second
    // place. It is a transitive dep read by path, not import, so knip.json
    // lists it under ignoreDependencies; every failure mode here (moved file,
    // reshaped manifest) lands in the catch and simply skips the override.
    const manifest = JSON.parse(
      readFileSync(new URL("../../node_modules/playwright-core/browsers.json", import.meta.url)),
    );
    want = manifest.browsers.find((b) => b.name === "chromium")?.revision;
  } catch {
    return {};
  }
  if (!want || existsSync(`${PW_ROOT}/chromium-${want}`)) return {};
  if (!existsSync(PREINSTALLED_CHROMIUM)) return {};
  process.stderr.write(
    `[e2e] @playwright/test wants chromium-${want}, which is not installed; ` +
      `using ${PREINSTALLED_CHROMIUM} instead (no download — see the comment in ` +
      `tests/e2e/playwright.config.js).\n`,
  );
  return { executablePath: PREINSTALLED_CHROMIUM };
}

export default defineConfig({
  testDir: fileURLToPath(new URL(".", import.meta.url)),
  // Everything matching this in tests/e2e/ is collected, including files git
  // does not know about — a scratch spec dropped here while debugging runs as
  // part of the suite. That is contained rather than papered over: CI checks
  // out tracked files only, so a local scratch file cannot become a CI test,
  // and the run's own header prints the file count.
  testMatch: "**/*.spec.js",
  // Scroll behaviour is timing-sensitive and the fixture server is shared, so
  // one worker: parallel navigation would interleave listing requests and make
  // a measured offset depend on which test happened to be mid-fetch.
  workers: 1,
  fullyParallel: false,
  // A flaky retry would mask exactly the kind of "sometimes the restore sticks"
  // behaviour this suite exists to measure.
  retries: 0,
  timeout: 60_000,
  reporter: [["list"]],
  outputDir: fileURLToPath(new URL("./test-results", import.meta.url)),
  use: {
    baseURL: BASE_URL,
    // Mobile-first pack, and the reported symptom is mobile-only. iPhone-13
    // class metrics, spelled out rather than taken from a `devices[...]`
    // descriptor: the shipped mobile descriptors select WebKit, and only
    // Chromium exists here.
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
    trace: "retain-on-failure",
    launchOptions: chromiumOverride(),
  },
  projects: [
    {
      name: "chromium-mobile",
      // Force the FULL Chromium build rather than the stripped
      // chromium_headless_shell: the subject matter is layout, scrolling and
      // scroll anchoring, so the harness must run the same rendering path a
      // phone browser does.
      use: { browserName: "chromium", channel: "chromium" },
    },
  ],
  webServer: {
    command: `node ${fileURLToPath(new URL("./server.mjs", import.meta.url))}`,
    url: `${BASE_URL}/__fixture/health`,
    reuseExistingServer: !process.env.CI,
    env: { GL_E2E_PORT: String(PORT) },
    stdout: "pipe",
    stderr: "pipe",
  },
});
