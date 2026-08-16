// Stub ComfyUI server for the Playwright (browser) suite.
//
// A PORT of comfyui-image-browser/tests/e2e/server.mjs — same virtual tree, same
// real-PNG encoder, same statelessness, retargeted at this pack's endpoints and
// at the picker's own open path (a widget + node, not a standalone command).
// Kept deliberately identical where it can be: the two packs now share one
// scroll mechanism, and a measurement is only comparable across them if the
// thing being measured is laid out the same way.
//
// WHY a real HTTP server instead of page.route() stubs: the thing under test is
// LAYOUT — how the grid's height grows as thumbnails land, and whether an
// assigned scrollTop survives that. Route interception changes request timing
// and (for a 404) changes the painted box, so the measurement would be of the
// harness rather than of the bundle. This serves the CURRENT `web/dist/index.js`
// verbatim, with real image bytes behind /gallery_loader/thumb.
//
// Node stdlib only, deliberately: this file is dev-time tooling under tests/
// (excluded from the registry tarball by .comfyignore) and must not drag a
// dependency into a pack whose hard rule is "no new deps".
//
// Routes:
//   GET /                                        → fixture.html
//   GET /scripts/app.js                          → the vitest ComfyUI app stub,
//                                                   reused verbatim (the bundle
//                                                   leaves this import UNBUNDLED)
//   GET /extensions/comfyui-gallery-loader/index.js → web/dist/index.js
//   GET /gallery_loader/base                     → well-known dirs
//   GET /gallery_loader/list                     → virtual tree (below)
//   GET /gallery_loader/thumb                    → real PNG bytes
//   GET /gallery_loader/file                     → same bytes (video/full size)
//   GET/POST /gallery_loader/pins                → empty pin list (the picker
//                                                  fetches it on EVERY load)
//   POST /gallery_loader/{rating,tag}            → stateless success
//   GET /__fixture/health                        → readiness probe for webServer

import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..", "..");

export const DEFAULT_PORT = 8299;

// ============================================================
// The virtual tree
// ============================================================
//
// Listing size is parameterised by FOLDER NAME, not by server state: a folder
// called `bulk-<N>` contains exactly N files and no subfolders. A test that
// wants a deeply scrollable grid just navigates into `bulk-400`. Deriving the
// tree from the request instead of from a mutable config keeps the server
// stateless — no cross-test ordering hazard, and a test can be read in
// isolation because the URL it drives to fully determines what it will see.
const BULK_RE = /^bulk-(\d+)$/;

// Subfolders offered at each depth. Finite by construction (depth >= 3 is a
// leaf) so the recursive/flat listing terminates without a visited set.
const DIRS_BY_DEPTH = [["bulk-400", "bulk-24", "nested"], ["bulk-300", "deep"], ["bulk-120"]];

// Files in a non-bulk folder. Small but > one viewport at 390x844 (two grid
// columns), so even a root listing scrolls — a scroll test must never have to
// descend just to get a scrollbar.
const FILES_PER_PLAIN_DIR = 12;

// Mirrors the backend's FLAT_LIST_CAP contract (cap + `truncated: true`); the
// number is lower here only so a flat-view test can reach it without minutes
// of synthesis.
const FLAT_CAP = 2000;

// Fixed epoch (2025-01-01T00:00:00Z) so "Newest" sort is deterministic: file
// index 0 is the newest, and card order therefore equals name order under the
// default mtime:desc sort. A wall-clock base would make card→name assertions
// order-dependent on the second the suite happened to run.
const BASE_MTIME = 1735689600;

// Every file is a PNG with declared width/height. Uniform on purpose: a card
// only renders the `.ip-meta` dimensions row when width+height are present, so
// mixing them would give cards two different heights and make scroll offsets
// unpredictable. Images only (no video) — a <video> card would pull in a second
// media pipeline that has nothing to do with the scroll-restore measurement.
const DIMS = [
  [512, 512],
  [768, 512],
  [512, 768],
  [1024, 1024],
];

function depthOf(subfolder) {
  return subfolder ? subfolder.split("/").filter(Boolean).length : 0;
}

function leafOf(subfolder) {
  const parts = subfolder.split("/").filter(Boolean);
  return parts.length ? parts[parts.length - 1] : "";
}

// How many files a folder holds, and what its subfolders are. Exported so a
// spec asserts the expected card count from the SAME rule the server answers
// with, instead of restating "400" in two places that can drift apart.
export function folderSpec(subfolder) {
  const bulk = BULK_RE.exec(leafOf(subfolder));
  if (bulk) return { fileCount: Number(bulk[1]), dirs: [] };
  return {
    fileCount: FILES_PER_PLAIN_DIR,
    dirs: DIRS_BY_DEPTH[depthOf(subfolder)] ?? [],
  };
}

function makeFile(i, subpath) {
  const [width, height] = DIMS[i % DIMS.length];
  const f = {
    name: `img-${String(i + 1).padStart(4, "0")}.png`,
    ext: ".png",
    // Descending, one minute apart — index order == newest-first order.
    mtime: BASE_MTIME - i * 60,
    size: 4096 + i * 17,
    width,
    height,
  };
  if (subpath !== undefined) f.subpath = subpath;
  return f;
}

function listFolder(subfolder) {
  const spec = folderSpec(subfolder);
  return {
    dirs: spec.dirs.map((name, i) => ({ name, mtime: BASE_MTIME - i * 3600 })),
    files: Array.from({ length: spec.fileCount }, (_, i) => makeFile(i)),
  };
}

// Flat (recursive=1) listing: every descendant file tagged with its
// forward-slashed subpath relative to the requested folder ("" at the top
// level), dirs:[], capped like the backend.
function listRecursive(subfolder) {
  const files = [];
  let truncated = false;
  const walk = (abs, rel) => {
    if (truncated) return;
    const spec = folderSpec(abs);
    for (let i = 0; i < spec.fileCount; i++) {
      if (files.length >= FLAT_CAP) {
        truncated = true;
        return;
      }
      files.push(makeFile(i, rel));
    }
    for (const d of spec.dirs) {
      walk(abs ? `${abs}/${d}` : d, rel ? `${rel}/${d}` : d);
      if (truncated) return;
    }
  };
  walk(subfolder, "");
  return { dirs: [], files, truncated };
}

// ============================================================
// Real PNG bytes (stdlib encoder)
// ============================================================
//
// The thumbnails must be decodable images, not a 404 or a stub body: a broken
// <img> paints at a different intrinsic size and the layout under test changes.
// `.ip-thumb` is `aspect-ratio: 1/1` so the card's height does NOT depend on
// these pixels — that asymmetry is itself part of what the scroll measurement
// has to establish, so the harness must not prejudge it by serving nothing.
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

function solidPNG(size, rgb) {
  const raw = Buffer.alloc(size * (1 + size * 3));
  for (let y = 0; y < size; y++) {
    const row = y * (1 + size * 3);
    raw[row] = 0; // filter: none
    for (let x = 0; x < size; x++) {
      const p = row + 1 + x * 3;
      raw[p] = rgb[0];
      raw[p + 1] = rgb[1];
      raw[p + 2] = rgb[2];
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: truecolour
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(raw)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

// A small palette, picked by a hash of the requested name: distinct bytes per
// file (so nothing can be silently coalesced by the HTTP cache) without
// re-encoding a unique image per request.
const THUMBS = [
  [0x2f, 0x3a, 0x52],
  [0x52, 0x2f, 0x3a],
  [0x3a, 0x52, 0x2f],
  [0x6b, 0xa6, 0xff],
  [0xff, 0xb0, 0x2e],
  [0x9e, 0xc6, 0xff],
].map((rgb) => solidPNG(64, rgb));

function thumbFor(key) {
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) | 0;
  return THUMBS[Math.abs(h) % THUMBS.length];
}

// ============================================================
// HTTP
// ============================================================

function sendJSON(res, status, body) {
  const buf = Buffer.from(JSON.stringify(body));
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": buf.length,
    // The frontend fetches listings with cache:"no-cache"; be explicit anyway
    // so a stale listing can never explain a scroll measurement.
    "cache-control": "no-store",
  });
  res.end(buf);
}

function sendFile(res, absPath, type) {
  let buf;
  try {
    buf = readFileSync(absPath);
  } catch (e) {
    res.writeHead(500, { "content-type": "text/plain" });
    res.end(`fixture server could not read ${absPath}: ${e.message}`);
    return;
  }
  res.writeHead(200, {
    "content-type": type,
    "content-length": buf.length,
    "cache-control": "no-store",
  });
  res.end(buf);
}

function handleList(url, res) {
  const type = url.searchParams.get("type") || "output";
  if (type === "path") {
    // Path mode exists so the browse…/path tab is navigable; it is not where
    // the sandboxed-root scroll behaviour lives, so the tree is minimal.
    const abs = url.searchParams.get("path") || "/";
    const rel = abs.replace(/^\/fixture\/comfy\/?/, "").replace(/^\/+/, "");
    const { dirs, files } = listFolder(rel);
    sendJSON(res, 200, {
      ok: true,
      exists: true,
      type: "path",
      subfolder: "",
      path: abs,
      dirs,
      files,
    });
    return;
  }
  const subfolder = url.searchParams.get("subfolder") || "";
  const recursive = url.searchParams.get("recursive") === "1";
  const listing = recursive ? listRecursive(subfolder) : listFolder(subfolder);
  sendJSON(res, 200, {
    ok: true,
    exists: true,
    type,
    subfolder,
    path: `/fixture/comfy/${type}${subfolder ? `/${subfolder}` : ""}`,
    dirs: listing.dirs,
    files: listing.files,
    ...(listing.truncated ? { truncated: true } : {}),
  });
}

// The picker mutates nothing on disk except a rating (and a Safe View
// keyword), and pins live behind their own route. Answered statelessly: the
// scroll measurement drives a star click for its FRONTEND effect — the in-place
// repaint that follows — and a persisted rating would only add cross-test
// ordering hazards.
const WRITE_ROUTES = new Set(["/gallery_loader/rating", "/gallery_loader/tag"]);

function readBody(req) {
  return new Promise((resolve) => {
    let raw = "";
    req.on("data", (c) => {
      raw += c;
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(raw || "{}"));
      } catch {
        resolve({});
      }
    });
  });
}

function createFixtureServer() {
  return createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    const p = url.pathname;

    if (p === "/__fixture/health") {
      sendJSON(res, 200, { ok: true });
      return;
    }
    if (p === "/" || p === "/index.html") {
      sendFile(res, join(HERE, "fixture.html"), "text/html; charset=utf-8");
      return;
    }
    // The bundle's ONE unbundled import. Reuse the vitest mock verbatim rather
    // than forking a second stub — one `app` shape for both suites, so a
    // frontend-API change is felt in one place.
    if (p === "/scripts/app.js") {
      sendFile(res, join(REPO, "tests", "js", "__mocks__", "app.js"), "text/javascript");
      return;
    }
    // The served artifact, at the real URL (the pack directory name IS the URL
    // segment — see the hard rule in CLAUDE.md).
    if (p === "/extensions/comfyui-gallery-loader/index.js") {
      sendFile(res, join(REPO, "web", "dist", "index.js"), "text/javascript");
      return;
    }
    if (p === "/gallery_loader/base") {
      sendJSON(res, 200, {
        ok: true,
        base_path: "/fixture/comfy",
        input_dir: "/fixture/comfy/input",
        output_dir: "/fixture/comfy/output",
        temp_dir: "/fixture/comfy/temp",
        user_dir: "/fixture/comfy/user",
      });
      return;
    }
    if (p === "/gallery_loader/list") {
      handleList(url, res);
      return;
    }
    if (p === "/gallery_loader/thumb" || p === "/gallery_loader/file") {
      // Per-test latency shaping belongs in the TEST (page.route + route.fetch),
      // not here: one shared server cannot hold two tests' different delays.
      const key =
        url.searchParams.get("name") ||
        url.searchParams.get("filename") ||
        url.searchParams.get("path") ||
        "";
      const buf = thumbFor(key);
      res.writeHead(200, {
        "content-type": "image/png",
        "content-length": buf.length,
        "cache-control": "no-store",
      });
      res.end(buf);
      return;
    }
    // Write endpoints, answered STATELESSLY on purpose. The scroll-restore
    // measurement drives delete/rename for their FRONTEND effect — the
    // in-place `renderGrid()` that follows a surgical `state.files` edit — and
    // that path never re-lists, so a persisted mutation would add server state
    // (and cross-test ordering hazards) for nothing. `/rename` echoes the
    // requested name because the frontend patches the file in place from it.
    // The pin list. Fetched on EVERY load (refreshPins runs alongside the
    // listing), so a 404 here would put a console error in front of every
    // measurement. Answered as an empty list: pins are not what this suite
    // measures — the pinned TAB is a location like any other, and its scroll
    // slot follows the same rule as every other location's.
    if (p === "/gallery_loader/pins") {
      if (req.method === "POST") {
        readBody(req).then(() => sendJSON(res, 200, { ok: true, max: 200, pins: [] }));
        return;
      }
      sendJSON(res, 200, { ok: true, max: 200, pins: [] });
      return;
    }
    if (req.method === "POST" && WRITE_ROUTES.has(p)) {
      readBody(req).then((body) => {
        if (p === "/gallery_loader/tag") {
          sendJSON(res, 200, { ok: true, tags: body.present ? [body.tag] : [] });
          return;
        }
        sendJSON(res, 200, { ok: true });
      });
      return;
    }
    res.writeHead(404, { "content-type": "text/plain" });
    res.end(`fixture server: no route for ${p}`);
  });
}

// Run as a script (Playwright's `webServer` command) — but stay importable, so
// the specs can read the tree constants above without booting a second server.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const port = Number(process.env.GL_E2E_PORT || DEFAULT_PORT);
  createFixtureServer().listen(port, "127.0.0.1", () => {
    process.stdout.write(`fixture server on http://127.0.0.1:${port}\n`);
  });
}
