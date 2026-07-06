// image-picker.ts — opens a modal gallery picker on click of either:
//   - any LoadImage-family `image` combo widget (stock LoadImage,
//     LoadImageMask, LoadImageOutput) — Input/Output/Temp tabs, writes
//     annotated values like "foo.png [output]" that core LoadImage's
//     folder_paths.get_annotated_filepath resolves transparently.
//   - any VHS path-loader's STRING widget (VHS_LoadImagePath,
//     VHS_LoadImagesPath, VHS_LoadVideoPath, VHS_LoadVideoFFmpegPath) —
//     opens in path-mode rooted at folder_paths.base_path; commits a
//     raw absolute path. Directory loaders (LoadImagesPath) get a
//     footer "Use this folder" button; clicks on folders still descend.
//
// Architecture:
//   @laurigates/comfy-modal-kit — backdrop, dialog, header, search row,
//                     body, footer, keyboard ESC, single-modal discipline
//                     (openModalShell) + fzf-lite fuzzy matcher (fuzzyScore).
//                     Inlined into web/dist by bun build. See ADR-0010.
//   image-picker.ts — this file: widget hooks + grid renderer + listing
//                     fetch against /gallery_loader/list.
//
// The inline-grid `GalleryLoadImage` node (gallery_loader.ts) is
// unchanged — workflows that use it keep working.

import {
  appendButtonWidget,
  applyStars,
  type ButtonWidgetHost,
  ensureStyleOnce,
  fuzzyScore,
  nextRating,
  notify,
  openModalShell,
  type PointerPatchableWidget,
  patchWidgetPointer,
  postRating,
  type RatingAddress,
  ratingOf,
  starsHTML,
  warnRating,
} from "@laurigates/comfy-modal-kit";
import { app } from "/scripts/app.js";

const EXT_NAME = "comfyui-gallery-loader";
const LIST_URL = "/gallery_loader/list";
const FILE_URL = "/gallery_loader/file";
const BASE_URL = "/gallery_loader/base";
const RATING_URL = "/gallery_loader/rating";
const STYLE_ID = "ip-style";

// Trace logging is opt-in. Enable in devtools with
//   localStorage.setItem("comfyui-gallery-loader:debug", "1")
// to see lifecycle / enhance traces (via console.debug). Failures always log
// through console.warn/console.error regardless of this flag.
const DEBUG = (() => {
  try {
    return localStorage.getItem(`${EXT_NAME}:debug`) === "1";
  } catch {
    return false;
  }
})();

function debug(...args: unknown[]): void {
  if (DEBUG) console.debug(`[${EXT_NAME}]`, ...args);
}

const IMG_EXTS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".webp",
  ".gif",
  ".bmp",
  ".tiff",
  ".tif",
  ".avif",
]);
const VIDEO_EXTS = new Set([".mp4", ".webm", ".mov", ".mkv", ".avi", ".m4v", ".mpg", ".mpeg"]);

// Persisted sort preference. One shared key across every picker flavour so a
// user's "Name A→Z" choice sticks regardless of which node opened the modal.
const SORT_STORAGE_KEY = "comfyui-gallery-loader:sort";
const VALID_SORTS = new Set([
  "mtime:desc",
  "mtime:asc",
  "name:asc",
  "name:desc",
  "size:desc",
  "pixels:desc",
  "rating:desc",
  "rating:asc",
]);

// ============================================================
// Types
// ============================================================
//
// The package exports `ComfyApp` at the module root but not the widget / node
// / node-def interfaces (declared internally, un-exported). The pack models
// the small surface it touches with local structural interfaces.

interface PickerWidget {
  name: string;
  value: unknown;
  type?: string;
  options?: {
    values?: unknown;
    tooltip?: string;
    vhs_path_extensions?: unknown;
    _origImageUpload?: boolean;
  } & Record<string, unknown>;
  callback?: (value: unknown, ...rest: unknown[]) => unknown;
  onPointerDown?: (pointer: unknown, node: PickerNode, canvas: unknown) => boolean | undefined;
  inputEl?: { value?: string } & Record<string, unknown>;
  // The frontend's widgets_values save/restore keys on THIS flag, not
  // options.serialize — a non-serialized widget must set it directly.
  serialize?: boolean;
}

interface PickerNode {
  widgets?: PickerWidget[];
  comfyClass?: string;
  type?: string;
  addWidget: (
    type: string,
    label: string,
    value: unknown,
    callback: (...args: unknown[]) => unknown,
    options?: Record<string, unknown>,
  ) => unknown;
  setDirtyCanvas?: (fg: boolean, bg: boolean) => void;
  _galleryPickerEnhanced?: boolean;
  _vhsGalleryEnhanced?: boolean;
}

interface NodeDataInput {
  required?: Record<string, unknown>;
  optional?: Record<string, unknown>;
}

interface NodeData {
  name?: string;
  input?: NodeDataInput;
}

interface BasePaths {
  base_path: string;
  input_dir: string;
  output_dir: string;
  temp_dir: string;
  ok?: boolean;
  error?: string;
}

interface ListingDir {
  name: string;
}

interface ListingFile {
  name: string;
  ext?: string;
  mtime: number;
  size?: number;
  width?: number;
  height?: number;
  rating?: number;
}

type PickerKind = "loadimage" | "vhs-path";
type PickerMode = "file" | "directory";

interface OpenOpts {
  kind: PickerKind;
  mode?: PickerMode;
  extensions?: string[];
}

interface SavedSort {
  key: string;
  dir: string;
}

function loadSavedSort(): SavedSort | null {
  try {
    const raw = localStorage.getItem(SORT_STORAGE_KEY);
    if (!raw || !VALID_SORTS.has(raw)) return null;
    const [key, dir] = raw.split(":");
    return { key: key as string, dir: dir as string };
  } catch (e) {
    console.warn(`[${EXT_NAME}] could not read saved sort`, e);
    return null;
  }
}

function saveSort(key: string, dir: string): void {
  try {
    localStorage.setItem(SORT_STORAGE_KEY, `${key}:${dir}`);
  } catch (e) {
    console.warn(`[${EXT_NAME}] could not save sort`, e);
  }
}

// VHS path-loaders the picker takes over. VHS_VideoCombine also exposes
// `vhs_path_extensions` on its filename_prefix widget, but it's an output
// prefix — not a candidate for the picker.
const VHS_PATH_LOADERS = new Set([
  "VHS_LoadImagePath",
  "VHS_LoadImagesPath",
  "VHS_LoadVideoPath",
  "VHS_LoadVideoFFmpegPath",
]);

// Cached /gallery_loader/base response. Set once on first picker open.
let BASE_PATHS: BasePaths | null = null;

async function fetchBasePaths(): Promise<BasePaths> {
  if (BASE_PATHS) return BASE_PATHS;
  let resolved: BasePaths;
  try {
    const r = await fetch(BASE_URL);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const data = await r.json();
    if (!data.ok) throw new Error(data.error || "base paths fetch failed");
    resolved = data;
  } catch (e) {
    console.warn(`[${EXT_NAME}] /gallery_loader/base failed`, e);
    resolved = { base_path: "/", input_dir: "", output_dir: "", temp_dir: "" };
  }
  BASE_PATHS = resolved;
  return resolved;
}

// ============================================================
// image_upload defang (stock LoadImage path) — unchanged
// ============================================================
//
// Modern ComfyUI mounts a Vue WidgetSelect / Asset Browser component on any
// combo with `image_upload: true` and routes the click through Vue — so
// widget.onPointerDown never fires. We work around that by stripping the
// `image_upload` flag from the input spec in beforeRegisterNodeDef, before
// the widget is constructed. With the flag gone the widget falls back to a
// plain LiteGraph canvas combo, which calls widget.onPointerDown as
// expected.
//
// Trade-off: the native "Upload image" button is tied to the same flag, so
// it disappears too. The modal can grow its own upload action later.

function isImageUploadEntry(entry: unknown): boolean {
  if (Array.isArray(entry) && entry.length >= 2) {
    const opts = entry[1];
    return (
      !!opts && typeof opts === "object" && (opts as Record<string, unknown>).image_upload === true
    );
  }
  if (entry && typeof entry === "object" && !Array.isArray(entry)) {
    return (entry as Record<string, unknown>).image_upload === true;
  }
  return false;
}

function defangNodeData(nodeData: NodeData | null | undefined): boolean {
  const inputs = nodeData?.input;
  if (!inputs) return false;
  let touched = false;
  for (const group of ["required", "optional"] as const) {
    const block = inputs[group];
    if (!block) continue;
    for (const [name, entry] of Object.entries(block)) {
      if (!isImageUploadEntry(entry)) continue;
      if (Array.isArray(entry)) {
        (entry[1] as Record<string, unknown>).image_upload = false;
        (entry[1] as Record<string, unknown>)._origImageUpload = true;
      } else {
        (entry as Record<string, unknown>).image_upload = false;
        (entry as Record<string, unknown>)._origImageUpload = true;
      }
      touched = true;
      debug(`defanged image_upload on ${nodeData?.name}.${name}`);
    }
  }
  return touched;
}

function findImageWidget(node: PickerNode): PickerWidget | null {
  if (!node?.widgets) return null;
  for (const w of node.widgets) {
    if (w?.options?._origImageUpload === true) return w;
  }
  const looksLikeLoader =
    node.comfyClass === "LoadImage" ||
    node.comfyClass === "LoadImageMask" ||
    node.comfyClass === "LoadImageOutput" ||
    node.type === "LoadImage" ||
    node.type === "LoadImageMask" ||
    node.type === "LoadImageOutput";
  if (!looksLikeLoader) return null;
  for (const w of node.widgets) {
    if (w?.name === "image") return w;
  }
  return null;
}

function enhanceLoadImageNode(node: PickerNode): void {
  if (!node?.widgets) return;
  if (node._galleryPickerEnhanced) return;
  const w = findImageWidget(node);
  if (!w) return;
  node._galleryPickerEnhanced = true;

  // If the loaded value is an annotated output/temp form, the combo's
  // values list (rebuilt from input/) won't contain it — the canvas
  // shows the literal text but the dropdown looks empty. Append so the
  // value validates against the combo's options.
  const v = (typeof w.value === "string" ? w.value : "").trim();
  if (/\[(output|temp)\]\s*$/.test(v)) {
    const values = w.options?.values;
    if (Array.isArray(values) && !values.includes(v)) values.push(v);
  }

  debug(`enhancing ${node.comfyClass || node.type}:`, {
    widgetName: w.name,
    widgetType: w.type,
  });

  const existing = w.options?.tooltip || "";
  const hint = "Click to open the gallery picker (or use the 📁 button below).";
  if (w.options) {
    w.options.tooltip = existing ? `${existing}\n\n${hint}` : hint;
  }

  // Strategy A — patch widget.onPointerDown via the kit's uniform
  // chain-then-consume wrapper (falls back to the native control on error).
  patchWidgetPointer(w as unknown as PointerPatchableWidget, (_pointer, ownerNode) => {
    openImagePicker(w, (ownerNode as PickerNode) || node, { kind: "loadimage" });
    return true;
  });

  // Strategy B — guaranteed click path via a button widget.
  appendButtonWidget(
    node as ButtonWidgetHost,
    "📁 Browse gallery",
    () => {
      openImagePicker(w, node, { kind: "loadimage" });
    },
    { logPrefix: EXT_NAME },
  );
}

// ============================================================
// VHS path-loader hook (STRING widget + vhs_path_extensions)
// ============================================================

function findVHSPathWidget(node: PickerNode): PickerWidget | null {
  if (!node?.widgets) return null;
  for (const w of node.widgets) {
    if (Array.isArray(w?.options?.vhs_path_extensions)) return w;
  }
  return null;
}

function enhanceVHSPathNode(node: PickerNode): void {
  if (!node?.widgets) return;
  if (node._vhsGalleryEnhanced) return;
  if (!node.comfyClass || !VHS_PATH_LOADERS.has(node.comfyClass)) return;
  const w = findVHSPathWidget(node);
  if (!w) return;
  node._vhsGalleryEnhanced = true;

  const exts = w.options?.vhs_path_extensions as unknown[] | undefined;
  const isDirectoryMode = Array.isArray(exts) && exts.length === 0;
  debug(`enhancing VHS ${node.comfyClass}:`, {
    widgetName: w.name,
    mode: isDirectoryMode ? "directory" : "file",
    exts,
  });

  const label = isDirectoryMode ? "📁 Browse folder" : "📁 Browse files";
  // Strategy B via the kit helper (serialize:false on the widget, kept last —
  // the widgets_values corruption guards live in the kit's appendButtonWidget).
  appendButtonWidget(
    node as ButtonWidgetHost,
    label,
    () => {
      openImagePicker(w, node, {
        kind: "vhs-path",
        mode: isDirectoryMode ? "directory" : "file",
        extensions: exts as string[],
      });
    },
    { logPrefix: EXT_NAME },
  );
}

// ============================================================
// Value parsing / building
// ============================================================

function isAbsPath(v: string): boolean {
  return v.startsWith("/") || /^[A-Za-z]:[\\/]/.test(v);
}

interface ParsedLoadImage {
  type: string;
  subfolder: string;
  name: string;
}

function parseLoadImageValue(v: unknown): ParsedLoadImage {
  // LoadImage value: "filename" or "subfolder/filename" or annotated
  // "foo.png [input|output|temp]". Returns { type, subfolder, name }.
  const s = (typeof v === "string" ? v : "").trim();
  if (!s) return { type: "input", subfolder: "", name: "" };
  const ann = s.match(/^(.*?)\s*\[(input|output|temp)\]\s*$/);
  if (ann) {
    const rel = (ann[1] as string).replace(/\\/g, "/");
    const idx = rel.lastIndexOf("/");
    return {
      type: ann[2] as string,
      subfolder: idx >= 0 ? rel.slice(0, idx) : "",
      name: idx >= 0 ? rel.slice(idx + 1) : rel,
    };
  }
  const norm = s.replace(/\\/g, "/");
  const idx = norm.lastIndexOf("/");
  return {
    type: "input",
    subfolder: idx >= 0 ? norm.slice(0, idx) : "",
    name: idx >= 0 ? norm.slice(idx + 1) : norm,
  };
}

interface ParsedAbs {
  dir: string;
  name: string;
}

function parseAbsPath(v: unknown): ParsedAbs {
  // For VHS path widgets. Splits an abs path into { dir, name }.
  const s = (typeof v === "string" ? v : "").trim();
  if (!s || !isAbsPath(s)) return { dir: "", name: "" };
  const norm = s.replace(/\\/g, "/");
  const idx = norm.lastIndexOf("/");
  return {
    dir: idx > 0 ? norm.slice(0, idx) : "/",
    name: idx >= 0 ? norm.slice(idx + 1) : "",
  };
}

function buildLoadImageValue(type: string, subfolder: string, name: string): string {
  const sub = (subfolder || "").replace(/^\/+|\/+$/g, "");
  const rel = sub ? `${sub}/${name}` : name;
  // Preserve the existing bare-relative form for input so existing
  // workflows don't churn on save/reload.
  return type === "input" ? rel : `${rel} [${type}]`;
}

function joinAbs(dir: string, name: string): string {
  const d = (dir || "/").replace(/\/+$/, "");
  return d === "" ? `/${name}` : `${d}/${name}`;
}

// ============================================================
// Thumbnail URL dispatch
// ============================================================

// All image thumbnails go through the pack's own /thumb endpoint (never core
// /api/view, which re-encodes on every request with no cache headers). The
// ?v= cache key (mtime + size from /list) pairs with the backend's long
// max-age: a changed file keys a new URL, an unchanged one never re-fetches.
function thumbVersion(f: ListingFile): string {
  return `${f.mtime}-${f.size ?? 0}`;
}

function imageThumbURL(type: string, subfolder: string, f: ListingFile): string {
  const p = new URLSearchParams({
    type,
    subfolder: subfolder || "",
    name: f.name,
    v: thumbVersion(f),
  });
  return `/gallery_loader/thumb?${p.toString()}`;
}

function imageThumbURLAbs(absDir: string, f: ListingFile): string {
  const full = joinAbs(absDir, f.name);
  return `/gallery_loader/thumb?path=${encodeURIComponent(full)}&v=${encodeURIComponent(thumbVersion(f))}`;
}

function videoSrcURL(type: string, subfolder: string, name: string, absDir?: string): string {
  if (type === "path") {
    const full = joinAbs(absDir || "", name);
    return `${FILE_URL}?path=${encodeURIComponent(full)}`;
  }
  const p = new URLSearchParams({ filename: name, type, subfolder: subfolder || "" });
  return `/api/view?${p.toString()}`;
}

// ============================================================
// Picker
// ============================================================

interface PickerState {
  kind: PickerKind;
  mode: PickerMode;
  type: string;
  subfolder: string;
  absPath: string;
  currentName: string;
  dirs: ListingDir[];
  files: ListingFile[];
  sortKey: string;
  sortDir: string;
  query: string;
  didInitialScroll: boolean;
  extensionsParam: string[] | null;
}

interface InitialSnapshot {
  type: string;
  subfolder: string;
  name: string;
}

interface ThumbDescriptor {
  kind: "img" | "video" | "icon";
  src?: string;
  text?: string;
}

async function openImagePicker(
  widget: PickerWidget,
  node: PickerNode,
  opts: OpenOpts,
): Promise<void> {
  ensureStyleOnce(STYLE_ID, PICKER_CSS);

  // Resolve opts → initial state
  const kind = opts.kind; // "loadimage" | "vhs-path"
  const mode: PickerMode = opts.mode || "file"; // "file" | "directory"
  const extensions = Array.isArray(opts.extensions) ? opts.extensions : null;

  const state: PickerState = {
    kind,
    mode,
    // For loadimage: type ∈ {input, output, temp}; subfolder relative to root.
    // For vhs-path: type = "path"; absPath holds the current absolute dir.
    type: "input",
    subfolder: "",
    absPath: "",
    currentName: "",
    // Listing data
    dirs: [],
    files: [],
    sortKey: "mtime",
    sortDir: "desc",
    query: "",
    // Whether the modal has performed its one-time scroll to the currently
    // loaded image. Restoring that position makes finding the next image easy.
    didInitialScroll: false,
    // The set of extension strings (".mp4", ".png", …) we'll send to the
    // backend. null → backend's default (images).
    extensionsParam: null,
  };

  // Restore the user's last-used sort so it persists across modal opens.
  const savedSort = loadSavedSort();
  if (savedSort) {
    state.sortKey = savedSort.key;
    state.sortDir = savedSort.dir;
  }

  let initialSnapshot: InitialSnapshot;
  if (kind === "loadimage") {
    const init = parseLoadImageValue(widget.value);
    state.type = init.type;
    state.subfolder = init.subfolder;
    state.currentName = init.name;
    initialSnapshot = { type: init.type, subfolder: init.subfolder, name: init.name };
  } else {
    // vhs-path mode
    state.type = "path";
    state.extensionsParam = extensions?.length
      ? extensions.map((e) => (e.startsWith(".") ? e : `.${e}`))
      : mode === "directory"
        ? [".__none__"]
        : null;
    // For directory mode we don't want any files listed — backend will
    // skip everything with a non-matching ext, leaving only folders.

    const parsed = parseAbsPath(widget.value);
    if (parsed.dir) {
      state.absPath =
        mode === "directory" && parsed.name ? joinAbs(parsed.dir, parsed.name) : parsed.dir;
      state.currentName = parsed.name;
    } else {
      const bp = await fetchBasePaths();
      state.absPath = bp.base_path || "/";
    }
    initialSnapshot = { type: "path", subfolder: state.absPath, name: state.currentName };
  }

  const titleByKind =
    kind === "loadimage" ? "Choose image" : mode === "directory" ? "Choose folder" : "Choose file";

  const footerLeftHTML =
    mode === "directory"
      ? "<kbd>Esc</kbd> close · click a folder to descend · click <b>Use this folder</b> to commit"
      : "<kbd>Esc</kbd> close · click a card to select · click a folder to descend";

  const modal = openModalShell({
    title: titleByKind,
    subtitle: `(${widget.name})`,
    placeholder: "Filter by filename…",
    width: "min(1100px, calc(100vw - 16px))",
    height: "min(88vh, 820px)",
    footerLeftHTML,
    footerRightHTML: '<span class="ip-count"></span>',
  });

  // ---- Toolbar: tabs (loadimage only) + breadcrumbs + sort + refresh -
  let tabsEl: HTMLElement | null = null;
  if (kind === "loadimage") {
    tabsEl = document.createElement("div");
    tabsEl.className = "ip-tabs";
    for (const t of ["input", "output", "temp"]) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "ip-tab";
      b.dataset.type = t;
      b.textContent = t;
      tabsEl.appendChild(b);
    }
    modal.toolbarEl.appendChild(tabsEl);
  }

  const crumbsEl = document.createElement("div");
  crumbsEl.className = "ip-crumbs";

  const sortEl = document.createElement("select");
  sortEl.className = "ip-control";
  sortEl.title = "Sort";
  sortEl.innerHTML = `
        <option value="mtime:desc">Newest</option>
        <option value="mtime:asc">Oldest</option>
        <option value="name:asc">Name A→Z</option>
        <option value="name:desc">Name Z→A</option>
        <option value="size:desc">Largest file</option>
        <option value="pixels:desc">Highest resolution</option>
        <option value="rating:desc">Highest rating</option>
        <option value="rating:asc">Lowest rating</option>
    `;
  sortEl.value = `${state.sortKey}:${state.sortDir}`;

  const refreshEl = document.createElement("button");
  refreshEl.type = "button";
  refreshEl.className = "ip-control ip-icon";
  refreshEl.title = "Refresh";
  refreshEl.textContent = "⟳";

  modal.toolbarEl.append(crumbsEl, sortEl, refreshEl);

  // ---- Body: grid -------------------------------------------------
  const gridEl = document.createElement("div");
  gridEl.className = "ip-grid";
  modal.bodyEl.appendChild(gridEl);

  const countEl = modal.footerEl.querySelector(".ip-count") as HTMLElement | null;
  function setCount(visible: number, total: number): void {
    if (!countEl) return;
    countEl.textContent = `${visible} / ${total}`;
  }

  // ---- Footer "Use this folder" button (directory mode only) -----
  let useFolderEl: HTMLButtonElement | null = null;
  if (mode === "directory") {
    useFolderEl = document.createElement("button");
    useFolderEl.type = "button";
    useFolderEl.className = "ip-use-folder";
    useFolderEl.textContent = "Use this folder";
    // Replace the right cell content so the count chip moves up to
    // the toolbar feel (still visible above the button).
    const rightCell = modal.footerEl.lastElementChild;
    if (rightCell) {
      rightCell.appendChild(useFolderEl);
    }
    useFolderEl.addEventListener("click", () => commitFolder());
  }

  // ---- Wiring ----------------------------------------------------
  modal.searchEl.addEventListener("input", () => {
    state.query = modal.searchEl.value.toLowerCase().trim();
    renderGrid();
  });

  sortEl.addEventListener("change", () => {
    const [k, d] = sortEl.value.split(":");
    state.sortKey = k as string;
    state.sortDir = d as string;
    saveSort(k as string, d as string);
    renderGrid();
  });

  refreshEl.addEventListener("click", () => loadAndRender());

  if (tabsEl) {
    tabsEl.addEventListener("click", (e) => {
      const b = (e.target as HTMLElement).closest("[data-type]") as HTMLElement | null;
      if (!b) return;
      if (state.type === b.dataset.type) return;
      state.type = b.dataset.type as string;
      state.subfolder = "";
      loadAndRender();
    });
  }

  crumbsEl.addEventListener("click", (e) => {
    const c = (e.target as HTMLElement).closest("[data-sub], [data-abs]") as HTMLElement | null;
    if (!c) return;
    if (c.dataset.abs !== undefined) {
      state.absPath = c.dataset.abs || "/";
    } else {
      state.subfolder = c.dataset.sub || "";
    }
    loadAndRender();
  });

  // Star clicks rate the file without selecting/closing. Handled first; the
  // card handler below early-returns when the click landed on a star.
  gridEl.addEventListener("click", (e) => {
    const star = (e.target as HTMLElement).closest(".ip-star") as HTMLElement | null;
    if (!star) return;
    e.stopPropagation();
    const card = star.closest(".ip-card") as HTMLElement | null;
    const row = star.parentElement as HTMLElement | null;
    if (!card || !row) return;
    const cur = Number(row.dataset.rating || "0");
    setStarRating(card.dataset.name as string, row, nextRating(cur, Number(star.dataset.val)));
  });

  gridEl.addEventListener("click", (e) => {
    if ((e.target as HTMLElement).closest(".ip-star")) return;
    const card = (e.target as HTMLElement).closest(".ip-card") as HTMLElement | null;
    if (!card) return;
    if (card.classList.contains("is-up")) {
      navigateUp();
      return;
    }
    if (card.classList.contains("is-dir")) {
      navigateInto(card.dataset.name as string);
      return;
    }
    if (card.classList.contains("is-file")) {
      if (mode === "directory") return; // files are inert in dir mode
      commitFile(card.dataset.name as string, card.dataset.ext || "");
    }
  });

  function setStarRating(name: string, row: HTMLElement, next: number): void {
    const prev = Number(row.dataset.rating || "0");
    applyStars(row, next);
    const f = state.files.find((x) => x.name === name);
    if (f) f.rating = next;
    const addr: RatingAddress = {
      type: state.type,
      subfolder: state.subfolder,
      absDir: state.absPath,
      name,
    };
    postRating(RATING_URL, addr, next)
      .then((confirmed) => {
        if (confirmed !== next) {
          applyStars(row, confirmed);
          if (f) f.rating = confirmed;
        }
      })
      .catch((e) => {
        warnRating(EXT_NAME, e);
        notify({
          severity: "warn",
          summary: "Rating not saved",
          detail: String((e as Error)?.message ?? e),
        });
        applyStars(row, prev);
        if (f) f.rating = prev;
      });
  }

  function navigateUp(): void {
    if (state.type === "path") {
      const p = (state.absPath || "/").replace(/\/+$/, "");
      if (p === "" || p === "/") return; // already at root
      const i = p.lastIndexOf("/");
      state.absPath = i <= 0 ? "/" : p.slice(0, i);
    } else {
      const p = state.subfolder.replace(/\/+$/, "");
      const i = p.lastIndexOf("/");
      state.subfolder = i <= 0 ? "" : p.slice(0, i);
    }
    loadAndRender();
  }

  function navigateInto(name: string): void {
    if (state.type === "path") {
      state.absPath = joinAbs(state.absPath, name);
    } else {
      const base = state.subfolder.replace(/\/+$/, "");
      state.subfolder = base ? `${base}/${name}` : name;
    }
    loadAndRender();
  }

  // ---- Render ----------------------------------------------------

  function renderTabs(): void {
    if (!tabsEl) return;
    for (const b of tabsEl.querySelectorAll(".ip-tab")) {
      b.classList.toggle("is-active", (b as HTMLElement).dataset.type === state.type);
    }
  }

  function renderCrumbs(): void {
    crumbsEl.innerHTML = "";
    const mk = (text: string, attr: string, value: string) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "ip-crumb";
      b.setAttribute(attr, value);
      b.textContent = text;
      return b;
    };
    if (state.type === "path") {
      // Absolute-path breadcrumbs: "/", then each path segment.
      crumbsEl.appendChild(mk("/", "data-abs", "/"));
      const parts = state.absPath.split("/").filter(Boolean);
      let acc = "";
      for (const p of parts) {
        acc = `${acc}/${p}`;
        crumbsEl.appendChild(mk(p, "data-abs", acc));
      }
    } else {
      crumbsEl.appendChild(mk(state.type, "data-sub", ""));
      const parts = state.subfolder.split("/").filter(Boolean);
      let acc = "";
      for (const p of parts) {
        acc = acc ? `${acc}/${p}` : p;
        crumbsEl.appendChild(mk(p, "data-sub", acc));
      }
    }
  }

  function buildListingURL(): string {
    const p = new URLSearchParams();
    if (state.type === "path") {
      p.set("type", "path");
      p.set("path", state.absPath || "/");
    } else {
      p.set("type", state.type);
      p.set("subfolder", state.subfolder);
    }
    if (state.extensionsParam?.length) {
      p.set("extensions", state.extensionsParam.join(","));
    }
    return `${LIST_URL}?${p.toString()}`;
  }

  async function loadAndRender(): Promise<void> {
    renderTabs();
    renderCrumbs();
    modal.setBusy(true);
    modal.setStatus("Loading…");
    try {
      const r = await fetch(buildListingURL());
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data = await r.json();
      if (!data.ok) throw new Error(data.error || "listing failed");
      state.dirs = data.dirs || [];
      state.files = data.files || [];
      modal.setStatus(data.exists ? "" : "Directory not found.");
    } catch (e) {
      console.error(`[${EXT_NAME}] list failed:`, e);
      modal.setStatus(`Error: ${(e as Error).message}`);
      state.dirs = [];
      state.files = [];
    }
    modal.setBusy(false);
    renderGrid();
  }

  function thumbForFile(f: ListingFile): ThumbDescriptor {
    const ext = (f.ext || "").toLowerCase();
    if (state.type === "path") {
      if (IMG_EXTS.has(ext)) {
        return { kind: "img", src: imageThumbURLAbs(state.absPath, f) };
      }
      if (VIDEO_EXTS.has(ext)) {
        return { kind: "video", src: videoSrcURL("path", "", f.name, state.absPath) };
      }
      return { kind: "icon", text: "📄" };
    }
    if (IMG_EXTS.has(ext)) {
      return { kind: "img", src: imageThumbURL(state.type, state.subfolder, f) };
    }
    if (VIDEO_EXTS.has(ext)) {
      return { kind: "video", src: videoSrcURL(state.type, state.subfolder, f.name) };
    }
    return { kind: "icon", text: "📄" };
  }

  function renderGrid(): void {
    const q = state.query;
    gridEl.innerHTML = "";

    const showUp =
      state.type === "path" ? state.absPath && state.absPath !== "/" : !!state.subfolder;
    if (showUp) {
      const up = document.createElement("div");
      up.className = "ip-card is-up";
      up.innerHTML = `
                <div class="ip-thumb ip-thumb-icon">↑</div>
                <div class="ip-name">..</div>
            `;
      gridEl.appendChild(up);
    }

    for (const d of state.dirs) {
      if (q && !d.name.toLowerCase().includes(q)) continue;
      const c = document.createElement("div");
      c.className = "ip-card is-dir";
      c.dataset.name = d.name;
      c.innerHTML = `
                <div class="ip-thumb ip-thumb-icon">📁</div>
                <div class="ip-name" title="${escHTML(d.name)}">${escHTML(d.name)}</div>
            `;
      gridEl.appendChild(c);
    }

    let files = state.files;
    if (q) {
      const scored: { f: ListingFile; score: number }[] = [];
      for (const f of files) {
        const r = fuzzyScore(q, f.name);
        if (r) scored.push({ f, score: r.score });
      }
      scored.sort((a, b) => b.score - a.score);
      files = scored.map((x) => x.f);
    } else {
      files = sortFiles(files, state.sortKey, state.sortDir);
    }

    let visible = 0;
    const inSameLocation =
      state.type === "path"
        ? state.absPath === initialSnapshot.subfolder
        : state.type === initialSnapshot.type && state.subfolder === initialSnapshot.subfolder;
    for (const f of files) {
      const c = document.createElement("div");
      c.className = "ip-card is-file";
      c.dataset.name = f.name;
      c.dataset.ext = (f.ext || "").toLowerCase();
      if (inSameLocation && f.name === initialSnapshot.name) {
        c.classList.add("is-selected");
      }
      if (mode === "directory") {
        c.classList.add("is-inert");
      }
      const t = thumbForFile(f);
      const dims = f.width && f.height ? `${f.width}×${f.height}` : "";
      const when = new Date(f.mtime * 1000).toLocaleString();
      const titleText = dims ? `${f.name}\n${dims}\n${when}` : `${f.name}\n${when}`;
      const thumbInner =
        t.kind === "img"
          ? `<img loading="lazy" decoding="async" data-src="${t.src}" alt="">`
          : t.kind === "video"
            ? `<video muted playsinline preload="none" data-src="${t.src}"></video>`
            : `<div class="ip-thumb-icon">${t.text}</div>`;
      const stars = mode === "directory" ? "" : starsHTML("ip", ratingOf(f));
      c.innerHTML = `
                <div class="ip-thumb">${thumbInner}</div>
                <div class="ip-name" title="${escHTML(titleText)}">${escHTML(f.name)}</div>
                ${dims ? `<div class="ip-meta">${dims}</div>` : ""}
                ${stars}
            `;
      gridEl.appendChild(c);
      visible++;
    }

    const empty = !visible && !state.dirs.length && !showUp;
    if (empty) {
      const el = document.createElement("div");
      el.className = "ip-empty";
      el.textContent =
        mode === "directory" ? "No subfolders here." : "No matching files in this directory.";
      gridEl.appendChild(el);
    }

    if (useFolderEl) {
      useFolderEl.textContent =
        state.type === "path"
          ? `Use ${shortenPath(state.absPath)}`
          : `Use ${state.type}${state.subfolder ? `/${state.subfolder}` : ""}`;
    }

    setCount(visible, state.files.length);
    installLazyThumbs(gridEl);

    // On first paint, scroll the currently loaded image into the middle of the
    // viewport so the user lands where they left off — neighbours visible above
    // and below make picking the next image quick. Only once per modal open.
    if (!state.didInitialScroll) {
      state.didInitialScroll = true;
      scrollToSelected();
    }
  }

  function scrollToSelected(): void {
    const card = gridEl.querySelector(".ip-card.is-selected") as HTMLElement | null;
    if (!card) return;
    const body = modal.bodyEl;
    const target = card.offsetTop - Math.max(0, (body.clientHeight - card.offsetHeight) / 2);
    body.scrollTop = Math.max(0, target);
  }

  function shortenPath(p: string): string {
    if (!p) return "/";
    if (p.length <= 48) return p;
    return `…${p.slice(-46)}`;
  }

  function installLazyThumbs(root: HTMLElement): void {
    const els = root.querySelectorAll("img[data-src], video[data-src]");
    if (!els.length) return;
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (!e.isIntersecting) continue;
          const el = e.target as HTMLImageElement | HTMLVideoElement;
          const src = (el as HTMLElement).dataset.src;
          if (src) {
            if (el.tagName === "VIDEO") {
              // Switch to preload=metadata only when in view, so
              // the browser only fetches video headers for thumbs
              // the user actually scrolled to.
              (el as HTMLVideoElement).preload = "metadata";
            }
            el.src = src;
            el.removeAttribute("data-src");
          }
          io.unobserve(el);
        }
      },
      { root, rootMargin: "300px" },
    );
    for (const el of els) io.observe(el);
  }

  function commitFile(name: string, _ext: string): void {
    let value: string;
    if (state.type === "path") {
      value = joinAbs(state.absPath, name);
    } else {
      value = buildLoadImageValue(state.type, state.subfolder, name);
      // The native LiteGraph combo validates against options.values;
      // append so re-renders treat the new value as valid.
      const values = widget.options?.values;
      if (Array.isArray(values) && !values.includes(value)) {
        values.push(value);
      }
    }
    applyValue(value);
    modal.close();
  }

  function commitFolder(): void {
    const value =
      state.type === "path" ? state.absPath || "/" : state.subfolder ? state.subfolder : state.type;
    applyValue(value);
    modal.close();
  }

  function applyValue(value: string): void {
    widget.value = value;
    // STRING widgets that render via a DOM input keep their own copy;
    // sync it so the user sees the new value before the canvas redraws.
    if (widget.inputEl && typeof widget.inputEl.value === "string") {
      widget.inputEl.value = value;
    }
    try {
      widget.callback?.call(widget, value, app.canvas, node);
    } catch (e) {
      console.warn(`[${EXT_NAME}] widget callback threw`, e);
    }
    node?.setDirtyCanvas?.(true, true);
    app.graph?.setDirtyCanvas?.(true, true);
  }

  function sortFiles(files: ListingFile[], key: string, dir: string): ListingFile[] {
    const mul = dir === "asc" ? 1 : -1;
    const nameCmp = (a: ListingFile, b: ListingFile) =>
      a.name.localeCompare(b.name, undefined, {
        numeric: true,
        sensitivity: "base",
      });
    const numCmp =
      (getter: (f: ListingFile) => number | undefined) => (a: ListingFile, b: ListingFile) =>
        (getter(a) ?? 0) - (getter(b) ?? 0) || nameCmp(a, b);
    let cmp: (a: ListingFile, b: ListingFile) => number;
    switch (key) {
      case "name":
        cmp = nameCmp;
        break;
      case "size":
        cmp = numCmp((f) => f.size);
        break;
      case "pixels":
        cmp = numCmp((f) => (f.width && f.height ? f.width * f.height : 0));
        break;
      case "rating":
        cmp = numCmp((f) => f.rating);
        break;
      default:
        cmp = numCmp((f) => f.mtime);
        break;
    }
    return [...files].sort((a, b) => mul * cmp(a, b));
  }

  // First paint.
  loadAndRender();
}

// ============================================================
// Picker-specific styles (the modal shell handles the chrome)
// ============================================================

const PICKER_CSS = `
.ip-tabs {
    display: flex;
    gap: 2px;
    align-items: center;
    background: #1a1a22;
    border: 1px solid #2a2a32;
    border-radius: 4px;
    padding: 2px;
}
.ip-tab {
    background: transparent;
    color: #8a8a92;
    border: 0;
    border-radius: 3px;
    padding: 4px 12px;
    font-size: 12px;
    cursor: pointer;
    font-family: inherit;
    text-transform: capitalize;
}
.ip-tab:hover {
    background: #2a2a36;
    color: #e0e0e4;
}
.ip-tab.is-active {
    background: #2f3a52;
    color: #9ec6ff;
}
.ip-crumbs {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
    align-items: center;
    flex: 1;
    min-width: 0;
}
.ip-crumb {
    background: #2a2a36;
    color: #b8b8c0;
    border: 1px solid #3a3a44;
    border-radius: 4px;
    padding: 4px 10px;
    font-size: 12px;
    cursor: pointer;
    font-family: inherit;
}
.ip-crumb:hover {
    background: #3a3a4a;
    color: #fff;
}
.ip-control {
    background: #2a2a36;
    color: #d8d8dc;
    border: 1px solid #3a3a44;
    border-radius: 4px;
    padding: 4px 8px;
    font-size: 12px;
    cursor: pointer;
    font-family: inherit;
}
.ip-control:hover {
    background: #3a3a4a;
    color: #fff;
}
.ip-icon {
    min-width: 32px;
    text-align: center;
}
.ip-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));
    gap: 10px;
    padding: 4px;
}
.ip-card {
    background: #21212a;
    border: 1px solid #2a2a32;
    border-radius: 6px;
    overflow: hidden;
    cursor: pointer;
    display: flex;
    flex-direction: column;
    transition: transform 0.06s ease, border-color 0.1s ease;
}
.ip-card:hover {
    border-color: #6ba6ff;
    transform: translateY(-1px);
}
.ip-card.is-selected {
    border-color: #6bff8e;
    box-shadow: 0 0 0 1px #6bff8e inset;
}
.ip-card.is-up,
.ip-card.is-dir {
    background: #1f1f26;
}
.ip-card.is-file.is-inert {
    cursor: default;
    opacity: 0.55;
}
.ip-card.is-file.is-inert:hover {
    border-color: #2a2a32;
    transform: none;
}
.ip-thumb {
    aspect-ratio: 1 / 1;
    display: flex;
    align-items: center;
    justify-content: center;
    background: #12121a;
    overflow: hidden;
}
.ip-thumb-icon {
    font-size: 32px;
    color: #777;
}
.ip-thumb img,
.ip-thumb video {
    width: 100%;
    height: 100%;
    object-fit: cover;
    display: block;
    background: #000;
}
.ip-name {
    padding: 6px 8px;
    font-size: 11.5px;
    color: #d8d8dc;
    white-space: nowrap;
    text-overflow: ellipsis;
    overflow: hidden;
    font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
}
.ip-meta {
    padding: 0 8px 6px;
    font-size: 10.5px;
    color: #888;
}
.ip-stars {
    display: flex;
    justify-content: center;
    gap: 1px;
    padding: 0 6px 6px;
    margin-top: auto;
}
.ip-star {
    background: transparent;
    border: 0;
    padding: 0 1px;
    font-size: 13px;
    line-height: 1;
    color: #555;
    cursor: pointer;
    font-family: inherit;
}
.ip-star.is-on,
.ip-star:hover {
    color: #ffd866;
}
.ip-empty {
    grid-column: 1 / -1;
    padding: 40px;
    text-align: center;
    color: #777;
    font-style: italic;
}
.ip-count {
    color: #888;
}
.ip-use-folder {
    background: #2f3a52;
    color: #9ec6ff;
    border: 1px solid #4a5878;
    border-radius: 4px;
    padding: 6px 14px;
    font-size: 12px;
    cursor: pointer;
    font-family: inherit;
    margin-left: 8px;
}
.ip-use-folder:hover {
    background: #3a4868;
    color: #fff;
}
/* Kept for parity with sampler-info's si-match. */
.cmp-match {
    color: #ffd866;
    font-weight: 700;
}
`;

function escHTML(s: unknown): string {
  return String(s).replace(
    /[&<>"']/g,
    (c) =>
      (
        ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }) as Record<
          string,
          string
        >
      )[c] as string,
  );
}

// ============================================================
// Extension registration
// ============================================================

try {
  app.registerExtension({
    name: "comfy.gallery-loader.image-picker",
    async beforeRegisterNodeDef(_nodeType, nodeData) {
      try {
        defangNodeData(nodeData as unknown as NodeData);
      } catch (e) {
        console.warn(`[${EXT_NAME}] defang failed for ${(nodeData as NodeData)?.name}`, e);
      }
    },
    setup() {
      ensureStyleOnce(STYLE_ID, PICKER_CSS);
      debug("image-picker setup running");
      const nodes = (app?.graph as { _nodes?: unknown[] } | undefined)?._nodes;
      if (Array.isArray(nodes)) {
        for (const n of nodes) {
          enhanceLoadImageNode(n as PickerNode);
          enhanceVHSPathNode(n as PickerNode);
        }
      }
    },
    nodeCreated(node) {
      enhanceLoadImageNode(node as unknown as PickerNode);
      enhanceVHSPathNode(node as unknown as PickerNode);
    },
    loadedGraphNode(node) {
      enhanceLoadImageNode(node as unknown as PickerNode);
      enhanceVHSPathNode(node as unknown as PickerNode);
    },
  });
} catch (e) {
  console.error(`[${EXT_NAME}] image-picker.js: registerExtension threw`, e);
}
