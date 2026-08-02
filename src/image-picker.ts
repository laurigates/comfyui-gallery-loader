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
  copyTextToClipboard,
  ensureStyleOnce,
  fuzzyScore,
  highlightMatches,
  nextRating,
  notify,
  openModalShell,
  openShellOverlay,
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
const METADATA_URL = "/gallery_loader/metadata";
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
// NOTE: the inline node grid offers two orders this list lacks (size:asc,
// pixels:asc) while sharing the key above, so a preference set there is
// silently dropped here. Converging both surfaces on the kit's SORT_OPTIONS is
// the fix; it lands with the kit adoption, not with flat view.
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

const SANDBOXED_TYPES = ["input", "output", "temp"];

// Flat ("all subfolders") view preference.
type ViewMode = "folder" | "flat";
const VIEW_STORAGE_KEY = "comfyui-gallery-loader:view";
// Breadcrumb set while a flat load is in flight and cleared once the grid has
// painted. If it is STILL set at open time, the previous flat attempt never
// finished — the tab died under it — so the persisted preference would reopen
// straight into the same failure with no way to reach the toggle. Falling back
// to folder view is the only self-service escape.
const VIEW_PENDING_KEY = "comfyui-gallery-loader:view-pending";

interface SavedView {
  mode: ViewMode;
  recovered: boolean;
}

function loadSavedView(): SavedView {
  try {
    if (localStorage.getItem(VIEW_PENDING_KEY) === "1") {
      localStorage.removeItem(VIEW_PENDING_KEY);
      localStorage.setItem(VIEW_STORAGE_KEY, "folder");
      return { mode: "folder", recovered: true };
    }
    return {
      mode: localStorage.getItem(VIEW_STORAGE_KEY) === "flat" ? "flat" : "folder",
      recovered: false,
    };
  } catch {
    // Private mode / disabled storage — non-fatal.
    return { mode: "folder", recovered: false };
  }
}

function saveView(mode: ViewMode): void {
  try {
    localStorage.setItem(VIEW_STORAGE_KEY, mode);
  } catch {
    // Non-fatal.
  }
}

function markFlatPending(pending: boolean): void {
  try {
    if (pending) localStorage.setItem(VIEW_PENDING_KEY, "1");
    else localStorage.removeItem(VIEW_PENDING_KEY);
  } catch {
    // Non-fatal.
  }
}

// Pinned directories — quick-nav chips in the toolbar, for hopping between the
// few folders you actually pick from. Sandboxed roots only; a path-mode picker
// has no stable "type" to pin against.
const PINS_STORAGE_KEY = "comfyui-gallery-loader:pins";

interface Pin {
  type: string;
  subfolder: string;
}

function pinKey(p: Pin): string {
  return `${p.type}:${p.subfolder}`;
}

function pinLabel(p: Pin): string {
  return `${p.type}${p.subfolder ? `/${p.subfolder}` : ""}`;
}

function loadPins(): Pin[] {
  try {
    const raw = localStorage.getItem(PINS_STORAGE_KEY);
    if (!raw) return [];
    const arr: unknown = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    return arr.filter(
      (p): p is Pin =>
        !!p &&
        typeof (p as Pin).subfolder === "string" &&
        SANDBOXED_TYPES.includes((p as Pin).type),
    );
  } catch {
    return [];
  }
}

function savePins(pins: Pin[]): void {
  try {
    localStorage.setItem(PINS_STORAGE_KEY, JSON.stringify(pins));
  } catch {
    // Private mode / disabled storage — non-fatal.
  }
}

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
  // Present only in a recursive ("flat") listing: the file's directory relative
  // to the requested subfolder, forward-slashed, "" for a top-level file. A
  // folder listing omits the key entirely. Never address a file with this
  // directly — go through fileSub(), which joins it onto state.subfolder.
  subpath?: string;
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

// ---- Embedded generation metadata -------------------------------------

type MetaField =
  | "positive"
  | "negative"
  | "model"
  | "seed"
  | "steps"
  | "cfg"
  | "sampler"
  | "scheduler";

interface ImageMetadata {
  format: string;
  source: string;
  summary: Partial<Record<MetaField, unknown>>;
  raw: Record<string, string>;
  truncated: boolean;
}

// Fixed display order. NOT the response's own key order — that is JSON
// insertion order and varies by whichever tool wrote the file.
const META_FIELDS: { key: MetaField; label: string }[] = [
  { key: "positive", label: "Positive" },
  { key: "negative", label: "Negative" },
  { key: "model", label: "Model" },
  { key: "seed", label: "Seed" },
  { key: "steps", label: "Steps" },
  { key: "cfg", label: "CFG" },
  { key: "sampler", label: "Sampler" },
  { key: "scheduler", label: "Scheduler" },
];

interface MetaRow {
  key: MetaField;
  label: string;
  value: string;
}

// Drop anything missing or whitespace-only, so an unknown field never renders
// as a bare "Negative:" row with a Copy button that copies nothing.
function metaRows(summary: Partial<Record<MetaField, unknown>> | null | undefined): MetaRow[] {
  const rows: MetaRow[] = [];
  if (!summary || typeof summary !== "object") return rows;
  const bag = summary as Record<string, unknown>;
  for (const { key, label } of META_FIELDS) {
    const v = bag[key];
    if (v === undefined || v === null) continue;
    const value = String(v);
    if (!value.trim()) continue;
    rows.push({ key, label, value });
  }
  return rows;
}

// The "Copy all" payload. Multi-line prompts stay verbatim so the text can be
// pasted straight back into a prompt box.
function metaClipboardText(rows: MetaRow[]): string {
  return rows.map((r) => `${r.label}: ${r.value}`).join("\n");
}

async function fetchMetadata(
  type: string,
  subfolder: string,
  name: string,
  absDir: string,
): Promise<ImageMetadata> {
  const p = new URLSearchParams();
  if (type === "path") {
    p.set("path", joinAbs(absDir, name));
  } else {
    p.set("type", type);
    p.set("subfolder", subfolder);
    p.set("name", name);
  }
  const r = await fetch(`${METADATA_URL}?${p.toString()}`);
  let data: Record<string, unknown> = {};
  try {
    data = await r.json();
  } catch {
    // fall through to the status-based error below
  }
  if (!r.ok || !data.ok) {
    throw new Error((data.error as string) || `HTTP ${r.status}`);
  }
  return {
    format: (data.format as string) || "",
    source: (data.source as string) || "none",
    summary: (data.summary as Partial<Record<MetaField, unknown>>) || {},
    raw: (data.raw as Record<string, string>) || {},
    truncated: !!data.truncated,
  };
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
  viewMode: ViewMode;
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

// Exported as a test seam only — production callers reach it through the
// widget hooks below. The picker is otherwise pure side-effect registration
// with nothing importable, which is what left its DOM uncovered (see
// docs/trps/regression-gaps-initial-scaffold.md).
export async function openImagePicker(
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
    viewMode: "folder",
  };

  // Restore the user's last-used sort so it persists across modal opens.
  const savedSort = loadSavedSort();
  if (savedSort) {
    state.sortKey = savedSort.key;
    state.sortDir = savedSort.dir;
  }

  const savedView = loadSavedView();
  state.viewMode = savedView.mode;

  // Flat view is only in effect on a sandboxed root — the toggle is hidden on
  // the path tab and the backend ignores `recursive` there, so guard both.
  // Directory mode never lists files at all.
  function isFlat(): boolean {
    return (
      state.viewMode === "flat" && mode !== "directory" && SANDBOXED_TYPES.includes(state.type)
    );
  }

  // A file's effective subfolder: in folder view every file lives in
  // state.subfolder; in flat view each carries its own subpath, joined onto the
  // request subfolder. EVERY per-file address (thumbnail, rating, committed
  // value, subpath-label target) routes through this so both views share one
  // code path.
  function fileSub(f: ListingFile): string {
    const sp = f.subpath || "";
    if (!sp) return state.subfolder;
    const base = state.subfolder.replace(/\/+$/, "");
    return base ? `${base}/${sp}` : sp;
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

  // Flat view toggle: fold the current folder's whole subtree into one grid.
  // Sandboxed roots only, and meaningless in directory mode — so it is not
  // CREATED at all for those flavours rather than created-then-hidden, which is
  // how a dead control ships.
  let viewToggleEl: HTMLButtonElement | null = null;
  if (kind === "loadimage" && mode !== "directory") {
    viewToggleEl = document.createElement("button");
    viewToggleEl.type = "button";
    viewToggleEl.className = "ip-control ip-icon ip-view-toggle";
    viewToggleEl.title = "Flat view (all subfolders)";
    viewToggleEl.textContent = "≣";
  }

  // Pin the current folder / jump to a pinned one. Same gating as the flat
  // toggle: sandboxed roots only, so it is not created for a path picker.
  let pinToggleEl: HTMLButtonElement | null = null;
  let pinsEl: HTMLElement | null = null;
  if (kind === "loadimage") {
    pinToggleEl = document.createElement("button");
    pinToggleEl.type = "button";
    pinToggleEl.className = "ip-control ip-icon ip-pin-toggle";
    pinToggleEl.title = "Pin this folder";
    pinToggleEl.textContent = "📌";
    pinsEl = document.createElement("div");
    pinsEl.className = "ip-pins";
  }

  modal.toolbarEl.append(
    crumbsEl,
    ...(viewToggleEl ? [viewToggleEl] : []),
    ...(pinToggleEl ? [pinToggleEl] : []),
    sortEl,
    refreshEl,
    ...(pinsEl ? [pinsEl] : []),
  );

  function renderPins(): void {
    if (!pinToggleEl || !pinsEl) return;
    const pins = loadPins();
    const canPin = SANDBOXED_TYPES.includes(state.type);
    pinToggleEl.style.display = canPin ? "" : "none";
    const herePinned =
      canPin && pins.some((p) => p.type === state.type && p.subfolder === state.subfolder);
    pinToggleEl.classList.toggle("is-active", herePinned);
    pinToggleEl.title = herePinned ? "Unpin this folder" : "Pin this folder";
    pinsEl.innerHTML = "";
    pinsEl.style.display = pins.length ? "" : "none";
    for (const p of pins) {
      const chip = document.createElement("span");
      chip.className = "ip-pin-chip";
      chip.dataset.pinType = p.type;
      chip.dataset.pinSub = p.subfolder;
      if (p.type === state.type && p.subfolder === state.subfolder) {
        chip.classList.add("is-current");
      }
      const go = document.createElement("button");
      go.type = "button";
      go.className = "ip-pin-go";
      go.title = `Go to ${pinLabel(p)}`;
      go.textContent = `📌 ${pinLabel(p)}`;
      const x = document.createElement("button");
      x.type = "button";
      x.className = "ip-pin-x";
      x.title = `Unpin ${pinLabel(p)}`;
      x.textContent = "✕";
      chip.append(go, x);
      pinsEl.appendChild(chip);
    }
  }

  // The toggle's visibility follows the active tab, so it re-syncs per load.
  function renderViewToggle(): void {
    if (!viewToggleEl) return;
    const ok = SANDBOXED_TYPES.includes(state.type);
    viewToggleEl.style.display = ok ? "" : "none";
    viewToggleEl.classList.toggle("is-active", isFlat());
    viewToggleEl.title = isFlat() ? "Folder view" : "Flat view (all subfolders)";
  }

  // ---- Body: grid -------------------------------------------------
  const gridEl = document.createElement("div");
  gridEl.className = "ip-grid";
  modal.bodyEl.appendChild(gridEl);

  // The files currently painted, in render order. Cards carry their index into
  // this, which is the only safe identity once flat view can show two files
  // with the same name from different subfolders.
  let renderedFiles: ListingFile[] = [];

  function fileOfCard(card: HTMLElement): ListingFile | null {
    const idx = Number(card.dataset.idx);
    return Number.isInteger(idx) ? (renderedFiles[idx] ?? null) : null;
  }

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

  pinToggleEl?.addEventListener("click", () => {
    if (!SANDBOXED_TYPES.includes(state.type)) return;
    const cur: Pin = { type: state.type, subfolder: state.subfolder };
    const pins = loadPins();
    const next = pins.filter((p) => pinKey(p) !== pinKey(cur));
    // Nothing was removed ⇒ this folder wasn't pinned ⇒ pin it.
    if (next.length === pins.length) next.push(cur);
    savePins(next);
    renderPins();
  });

  pinsEl?.addEventListener("click", (e) => {
    const t = e.target as HTMLElement;
    const chip = t.closest("[data-pin-type]") as HTMLElement | null;
    if (!chip) return;
    const type = chip.dataset.pinType as string;
    if (!SANDBOXED_TYPES.includes(type)) return;
    const pin: Pin = { type, subfolder: chip.dataset.pinSub || "" };
    if (t.closest(".ip-pin-x")) {
      savePins(loadPins().filter((p) => pinKey(p) !== pinKey(pin)));
      renderPins();
      return;
    }
    if (pin.type === state.type && pin.subfolder === state.subfolder) return;
    state.type = pin.type;
    state.subfolder = pin.subfolder;
    loadAndRender();
  });

  viewToggleEl?.addEventListener("click", () => {
    if (!SANDBOXED_TYPES.includes(state.type)) return;
    state.viewMode = state.viewMode === "flat" ? "folder" : "flat";
    saveView(state.viewMode);
    // Flat needs a recursive re-fetch, so this is a reload, not a re-render.
    loadAndRender();
  });

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
    const f = fileOfCard(card);
    if (!f) return;
    const cur = Number(row.dataset.rating || "0");
    setStarRating(f, row, nextRating(cur, Number(star.dataset.val)));
  });

  gridEl.addEventListener("click", (e) => {
    const target = e.target as HTMLElement;
    if (target.closest(".ip-star")) return;
    const card = target.closest(".ip-card") as HTMLElement | null;
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
      if (target.closest(".ip-info")) {
        e.stopPropagation();
        const info = fileOfCard(card);
        if (info) void openMetadata(info);
        return;
      }
      // Flat view: the subpath label jumps to that folder in folder view.
      const subEl = target.closest(".ip-subpath") as HTMLElement | null;
      if (subEl?.dataset.sub !== undefined) {
        e.stopPropagation();
        state.viewMode = "folder";
        saveView("folder");
        state.subfolder = subEl.dataset.sub || "";
        loadAndRender();
        return;
      }
      const f = fileOfCard(card);
      if (f) commitFile(f);
    }
  });

  // ---- Metadata overlay ------------------------------------------
  // Kept in-dialog via openShellOverlay rather than a second openModalShell:
  // single-modal discipline means a nested shell would dismiss the picker.
  const copyFeedback = new WeakMap<
    HTMLButtonElement,
    { seq: number; timer: ReturnType<typeof setTimeout> | null }
  >();

  function copyInto(btn: HTMLButtonElement, text: string, restore: string): void {
    let fb = copyFeedback.get(btn);
    if (!fb) {
      fb = { seq: 0, timer: null };
      copyFeedback.set(btn, fb);
    }
    const slot = fb;
    const seq = ++slot.seq;
    // Hold the current feedback until this copy answers — no flicker back to
    // `restore` mid-flight — but drop the stale restore timer that would fire
    // out of order once this click's own timer is armed.
    if (slot.timer !== null) {
      clearTimeout(slot.timer);
      slot.timer = null;
    }
    void copyTextToClipboard(text).then((ok) => {
      if (slot.seq !== seq) return; // a later click owns the label now
      btn.textContent = ok ? "Copied ✓" : "Copy failed";
      btn.classList.toggle("is-copied", ok);
      slot.timer = setTimeout(() => {
        slot.timer = null;
        btn.textContent = restore;
        btn.classList.remove("is-copied");
      }, 1500);
    });
  }

  async function openMetadata(f: ListingFile): Promise<void> {
    // The overlay is dismissible while the read is in flight, so a late
    // response must not paint into a closed card.
    let live = true;
    const ov = openShellOverlay(modal, {
      onDismiss: () => {
        live = false;
      },
    });
    ov.card.classList.add("ip-meta-card");
    const close = (): void => {
      live = false;
      ov.close();
    };
    const title = `Metadata — ${escHTML(f.name)}`;
    // Painted synchronously: an overlay that appeared only after the read
    // would feel like a dead button on a big file or a slow disk.
    ov.card.innerHTML = `
      <div class="cmp-ov-title">${title}</div>
      <div class="ip-meta-body"><div class="ip-meta-status">Reading metadata…</div></div>
      <div class="cmp-ov-actions">
        <button type="button" class="cmp-ov-btn" data-meta-close>Close</button>
      </div>`;
    ov.card.querySelector("[data-meta-close]")?.addEventListener("click", close);

    let data: ImageMetadata;
    try {
      data = await fetchMetadata(state.type, fileSub(f), f.name, state.absPath);
    } catch (e) {
      // Close FIRST, then report: the toast stack is a body-level child above
      // the dialog, so its ✕ would land on the overlay's own controls.
      close();
      console.error(`[${EXT_NAME}] metadata read failed:`, e);
      notify({
        severity: "error",
        summary: "Metadata read failed",
        detail: String((e as Error)?.message ?? e),
      });
      return;
    }
    if (!live) return;

    const rows = metaRows(data.summary);
    const rawKeys = Object.keys(data.raw);
    const srcLabel =
      data.source === "comfyui"
        ? "ComfyUI"
        : data.source === "a1111"
          ? "A1111"
          : "no generation data";
    const rowsHTML = rows
      .map(
        (r, i) => `
        <div class="ip-meta-row">
          <div class="ip-meta-k">${escHTML(r.label)}</div>
          <div class="ip-meta-v">${escHTML(r.value)}</div>
          <button type="button" class="ip-meta-copy" data-copy-row="${i}">Copy</button>
        </div>`,
      )
      .join("");
    // Never invent a row. With nothing recognised the honest report is which of
    // the two cases it is: no embedded text at all, or text we couldn't map (in
    // which case the raw disclosure below is the whole answer).
    const emptyHTML = rows.length
      ? ""
      : `<div class="ip-meta-empty">${
          rawKeys.length ? "No recognised generation parameters." : "No generation metadata found."
        }</div>`;
    const rawJSON = JSON.stringify(data.raw, null, 2);
    const rawHTML = rawKeys.length
      ? `
        <details class="ip-meta-raw">
          <summary>Raw metadata (${rawKeys.length} key${rawKeys.length === 1 ? "" : "s"})</summary>
          <pre>${escHTML(rawJSON)}</pre>
          <button type="button" class="ip-meta-copy" data-copy-raw>Copy JSON</button>
        </details>`
      : "";
    const noteHTML = data.truncated
      ? `<div class="ip-meta-note">Some values were truncated by the server.</div>`
      : "";
    const copyAll = rows.length
      ? `<button type="button" class="cmp-ov-btn cmp-ov-primary" data-copy-all>Copy all</button>`
      : "";
    ov.card.innerHTML = `
      <div class="cmp-ov-title">${title}</div>
      <div class="ip-meta-body">
        <div class="ip-meta-src">${escHTML(srcLabel)}${
          data.format ? `<span class="ip-meta-fmt">${escHTML(data.format)}</span>` : ""
        }</div>
        ${emptyHTML}
        ${rowsHTML}
        ${noteHTML}
        ${rawHTML}
      </div>
      <div class="cmp-ov-actions">
        ${copyAll}
        <button type="button" class="cmp-ov-btn" data-meta-close>Close</button>
      </div>`;
    ov.card.querySelector("[data-meta-close]")?.addEventListener("click", close);
    // Each restore label is read ONCE here, off the freshly painted markup —
    // never inside the click handler, where a mid-feedback label would stick.
    for (const btn of ov.card.querySelectorAll<HTMLButtonElement>("[data-copy-row]")) {
      const row = rows[Number(btn.dataset.copyRow)];
      const label = btn.textContent || "Copy";
      if (row) btn.addEventListener("click", () => copyInto(btn, row.value, label));
    }
    const rawBtn = ov.card.querySelector<HTMLButtonElement>("[data-copy-raw]");
    const rawLabel = rawBtn?.textContent || "Copy JSON";
    rawBtn?.addEventListener("click", () => copyInto(rawBtn, rawJSON, rawLabel));
    const allBtn = ov.card.querySelector<HTMLButtonElement>("[data-copy-all]");
    const allLabel = allBtn?.textContent || "Copy all";
    allBtn?.addEventListener("click", () => copyInto(allBtn, metaClipboardText(rows), allLabel));
  }

  // Takes the file OBJECT, not its name: `state.files.find(byName)` rated the
  // first same-named file in the listing, which in flat view is routinely a
  // different file in a different folder — and the optimistic repaint made the
  // wrong write look like it had worked.
  function setStarRating(f: ListingFile, row: HTMLElement, next: number): void {
    const prev = Number(row.dataset.rating || "0");
    applyStars(row, next);
    f.rating = next;
    const addr: RatingAddress = {
      type: state.type,
      subfolder: fileSub(f),
      absDir: state.absPath,
      name: f.name,
    };
    postRating(RATING_URL, addr, next)
      .then((confirmed) => {
        if (confirmed !== next) {
          applyStars(row, confirmed);
          f.rating = confirmed;
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
        f.rating = prev;
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
      // Only ever on a sandboxed root. The backend ignores it for type=path
      // anyway; not sending it keeps that from being load-bearing.
      if (isFlat()) p.set("recursive", "1");
    }
    if (state.extensionsParam?.length) {
      p.set("extensions", state.extensionsParam.join(","));
    }
    return `${LIST_URL}?${p.toString()}`;
  }

  async function loadAndRender(): Promise<void> {
    renderTabs();
    renderCrumbs();
    renderViewToggle();
    renderPins();
    modal.setBusy(true);
    modal.setStatus("Loading…");
    markFlatPending(isFlat());
    try {
      const r = await fetch(buildListingURL());
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data = await r.json();
      if (!data.ok) throw new Error(data.error || "listing failed");
      state.dirs = data.dirs || [];
      state.files = data.files || [];
      modal.setStatus(data.exists ? "" : "Directory not found.");
      if (data.truncated) {
        notify({
          severity: "warn",
          summary: `Showing the newest ${state.files.length}`,
          detail: "This folder has more files than the listing returns; older ones are not shown.",
        });
      }
    } catch (e) {
      console.error(`[${EXT_NAME}] list failed:`, e);
      modal.setStatus(`Error: ${(e as Error).message}`);
      state.dirs = [];
      state.files = [];
    }
    modal.setBusy(false);
    renderGrid();
    // Cleared only once the grid has actually painted — that is what makes a
    // still-set flag at open time mean "the last flat load never finished".
    markFlatPending(false);
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
    const sub = fileSub(f);
    if (IMG_EXTS.has(ext)) {
      return { kind: "img", src: imageThumbURL(state.type, sub, f) };
    }
    if (VIDEO_EXTS.has(ext)) {
      return { kind: "video", src: videoSrcURL(state.type, sub, f.name) };
    }
    return { kind: "icon", text: "📄" };
  }

  function renderGrid(): void {
    const q = state.query;
    gridEl.innerHTML = "";

    // Flat view collapses the subtree into files only — no ".." card and no
    // folder cards (the backend returns dirs:[] recursively anyway). A ".."
    // here would silently drop out of flat view.
    const flat = isFlat();
    const showUp =
      !flat && (state.type === "path" ? state.absPath && state.absPath !== "/" : !!state.subfolder);
    if (showUp) {
      const up = document.createElement("div");
      up.className = "ip-card is-up";
      up.innerHTML = `
                <div class="ip-thumb ip-thumb-icon">↑</div>
                <div class="ip-name">..</div>
            `;
      gridEl.appendChild(up);
    }

    for (const d of flat ? [] : state.dirs) {
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
    // Match positions for the visible filename, keyed by file. Only populated
    // while filtering; `.cmp-match` styles them (the rule already shipped, with
    // nothing emitting it until now).
    const nameMatches = new Map<ListingFile, number[]>();
    if (q) {
      const scored: { f: ListingFile; score: number }[] = [];
      for (const f of files) {
        // In flat view the query matches "subpath/name" so you can filter by
        // folder too; folder view matches the bare filename as before.
        const prefix = flat && f.subpath ? `${f.subpath}/` : "";
        const r = fuzzyScore(q, `${prefix}${f.name}`);
        if (!r) continue;
        scored.push({ f, score: r.score });
        // Highlighting is applied to the NAME element, but the indices are
        // against the haystack — shift them back and drop anything that landed
        // on the subpath, which lives in its own element.
        const off = prefix.length;
        nameMatches.set(
          f,
          r.matches.map((i) => i - off).filter((i) => i >= 0),
        );
      }
      scored.sort((a, b) => b.score - a.score);
      files = scored.map((x) => x.f);
    } else {
      files = sortFiles(files, state.sortKey, state.sortDir);
    }

    // The rendered order IS the identity map: cards address their file by
    // index, never by name. In flat view a bare filename is not unique across
    // subfolders, so a name-keyed lookup silently commits (and rates) the wrong
    // ComfyUI_00001_.png.
    renderedFiles = files;

    let visible = 0;
    const inSameLocation =
      state.type === "path"
        ? state.absPath === initialSnapshot.subfolder
        : state.type === initialSnapshot.type && state.subfolder === initialSnapshot.subfolder;
    for (const [i, f] of files.entries()) {
      const c = document.createElement("div");
      c.className = "ip-card is-file";
      c.dataset.idx = String(i);
      c.dataset.name = f.name; // display/debug only — never an identity
      c.dataset.ext = (f.ext || "").toLowerCase();
      const selected = flat
        ? state.type === initialSnapshot.type &&
          fileSub(f) === initialSnapshot.subfolder &&
          f.name === initialSnapshot.name
        : inSameLocation && f.name === initialSnapshot.name;
      if (selected) {
        c.classList.add("is-selected");
      }
      if (flat) {
        c.classList.add("is-flat");
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
      // ⓘ opens the embedded generation metadata. Gated on the card being an
      // IMAGE, not on the tab: /metadata is a read and accepts type=path, so
      // it renders on a path picker too — the one control that isn't scoped to
      // sandboxed roots. Video cards get none (the endpoint is IMG_EXTS-gated).
      const infoBtn =
        mode !== "directory" && IMG_EXTS.has((f.ext || "").toLowerCase())
          ? `<button type="button" class="ip-info" title="Generation metadata">ⓘ</button>`
          : "";
      // Flat view: show the file's folder above the thumbnail. It's a button —
      // tapping it drops back to folder view at that directory. The LABEL is
      // the relative subpath (what the user reads) while data-sub is the joined
      // one (where the tap goes); they differ whenever flat view is entered
      // from a non-root subfolder, so a root-only test cannot see a mix-up.
      // Top-level files get a muted "/" so the row height stays consistent.
      const subLabel = flat
        ? f.subpath
          ? `<button type="button" class="ip-subpath" data-sub="${escHTML(fileSub(f))}" title="Go to ${escHTML(f.subpath)}">${escHTML(f.subpath)}</button>`
          : `<div class="ip-subpath is-root" title="Top level">/</div>`
        : "";
      c.innerHTML = `
                ${subLabel}
                <div class="ip-thumb">${thumbInner}${infoBtn}</div>
                <div class="ip-name" title="${escHTML(titleText)}">${escHTML(f.name)}</div>
                ${dims ? `<div class="ip-meta">${dims}</div>` : ""}
                ${stars}
            `;
      // Repaint the name with the matched characters wrapped. Done after the
      // template because highlightMatches builds a DocumentFragment, not a
      // string — and going through the DOM keeps the filename un-parsed as
      // markup, which the escaped template above was also relying on.
      const hits = nameMatches.get(f);
      if (hits?.length) {
        const nameEl = c.querySelector(".ip-name") as HTMLElement | null;
        if (nameEl) {
          nameEl.textContent = "";
          nameEl.appendChild(highlightMatches(f.name, hits));
        }
      }
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
    // Not in flat view: the target may be thousands of cards down a grid whose
    // thumbnails are all still data-src placeholders, so the single bare write
    // below lands against a shorter-than-final layout and gets CLAMPED at the
    // instant of assignment — leaving the view somewhere arbitrary once the
    // real heights arrive. Doing better needs a re-assert loop, which needs a
    // browser test suite this pack does not have; not scrolling is honest.
    if (!state.didInitialScroll && !isFlat()) {
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

  // Observer for the current render, kept so the next one can disconnect it
  // instead of leaking an observer (still referencing every detached card) per
  // navigation / sort / search keystroke.
  let thumbObserver: IntersectionObserver | null = null;

  function installLazyThumbs(container: HTMLElement): void {
    thumbObserver?.disconnect();
    thumbObserver = null;
    // Without the guard a browser lacking IntersectionObserver throws here and
    // takes the whole grid render down with it — thumbnails degrading to
    // never-loaded is survivable, an exception out of renderGrid is not.
    if (typeof IntersectionObserver === "undefined") return;
    const els = container.querySelectorAll("img[data-src], video[data-src]");
    if (!els.length) return;
    // The root MUST be the scrolling ancestor (modal.bodyEl / .cmp-body), NOT
    // the grid. `.ip-grid` has no overflow clip, so with the grid as root the
    // root rectangle is the grid's whole bounding box and EVERY card reports as
    // intersecting on the first callback — the "lazy" load fires for the entire
    // listing at once (measured 400/400 off-screen cards vs 20/400 with the
    // real scroller). A big output dir then issues one /thumb request per file
    // and gives every video a src + preload=metadata simultaneously.
    //
    // Note this differs from gallery_loader.ts, where `.gl-grid` IS the scroll
    // container and passing the grid is correct. The picker's grid lives inside
    // the modal shell's body, so the scroller moved and the root had to follow.
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
      { root: modal.bodyEl, rootMargin: "300px" },
    );
    for (const el of els) io.observe(el);
    thumbObserver = io;
  }

  // Takes the file object so flat view commits the file's OWN folder. The
  // value contract is unchanged: buildLoadImageValue already normalises a
  // nested subfolder, so a flat pick of a/b/x.png yields exactly what folder
  // navigation would have produced.
  function commitFile(f: ListingFile): void {
    let value: string;
    if (state.type === "path") {
      value = joinAbs(state.absPath, f.name);
    } else {
      value = buildLoadImageValue(state.type, fileSub(f), f.name);
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
  if (savedView.recovered) {
    notify({
      severity: "warn",
      summary: "Reopened in folder view",
      detail: "The last flat-view load didn't finish, so the picker fell back to folder view.",
    });
  }
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
/* Shared active state for toolbar controls (the flat-view toggle). */
.ip-control.is-active {
    background: #2f3a52;
    color: #9ec6ff;
}
/* ⓘ overlay button, pinned to the thumbnail's corner. */
.ip-thumb { position: relative; }
.ip-info {
    position: absolute; top: 4px; right: 4px;
    min-width: 30px; min-height: 30px; padding: 0;
    background: rgba(20, 20, 26, 0.78); color: #b8b8c0;
    border: 1px solid #33333f; border-radius: 4px;
    font-size: 14px; line-height: 1; cursor: pointer; font-family: inherit;
}
.ip-info:hover { background: #2f3a52; color: #9ec6ff; }

/* Metadata overlay (in-dialog — a nested modal shell would dismiss the picker). */
.ip-meta-card { width: min(680px, calc(100% - 24px)); max-height: calc(100% - 24px); }
.ip-meta-body {
    display: flex; flex-direction: column; gap: 8px;
    overflow-y: auto; padding: 8px 0; -webkit-overflow-scrolling: touch;
}
.ip-meta-status { padding: 14px 2px; font-size: 12.5px; color: #888; font-style: italic; }
.ip-meta-src {
    display: flex; align-items: baseline; gap: 8px; font-size: 11.5px; color: #9ec6ff;
    text-transform: uppercase; letter-spacing: 0.5px;
}
.ip-meta-fmt { color: #777; text-transform: none; letter-spacing: 0; }
.ip-meta-row { display: grid; grid-template-columns: 84px 1fr auto; gap: 8px; align-items: start; }
.ip-meta-k {
    padding-top: 7px; font-size: 11px; color: #8a8a92;
    text-transform: uppercase; letter-spacing: 0.4px;
}
.ip-meta-v {
    /* A long positive prompt scrolls inside its own box instead of pushing the
       Copy buttons and the overlay actions off the card. Selectable: the card
       is a reading surface. */
    max-height: 7.5em; overflow-y: auto;
    padding: 6px 8px; font-size: 12px; line-height: 1.45; color: #d8d8dc;
    background: #17171e; border: 1px solid #2a2a32; border-radius: 4px;
    font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
    white-space: pre-wrap; overflow-wrap: anywhere;
    user-select: text; -webkit-user-select: text;
}
.ip-meta-copy {
    background: #2a2a36; color: #b8b8c0; border: 1px solid #33333f; border-radius: 4px;
    padding: 0 10px; font-size: 12px; cursor: pointer; font-family: inherit; min-height: 32px;
}
.ip-meta-copy:hover { background: #3a3a4a; color: #fff; }
.ip-meta-copy.is-copied { background: #25402f; color: #8fe0a8; border-color: #37624a; }
.ip-meta-empty { padding: 16px 2px; font-size: 12.5px; color: #777; font-style: italic; }
.ip-meta-note { font-size: 11.5px; color: #c8a95c; }
.ip-meta-raw > summary {
    padding: 7px 0; font-size: 12px; color: #9ec6ff; cursor: pointer; min-height: 32px;
}
.ip-meta-raw pre {
    margin: 4px 0 8px; padding: 8px; max-height: 30vh; overflow: auto;
    background: #17171e; border: 1px solid #2a2a32; border-radius: 4px;
    font-size: 11px; color: #b8b8c0; white-space: pre-wrap; overflow-wrap: anywhere;
    user-select: text; -webkit-user-select: text;
}
/* Pinned-folder chips get their own toolbar row so they never crowd the
   crumbs or get painted under the sort dropdown. */
.ip-pins {
    order: 10; flex-basis: 100%;
    display: flex; flex-wrap: wrap; gap: 4px; align-items: center;
}
.ip-pin-chip { display: inline-flex; align-items: stretch; }
.ip-pin-go {
    background: #23283a; color: #9ec6ff; border: 1px solid #3a4560; border-right: 0;
    border-radius: 4px 0 0 4px; padding: 6px 8px; font-size: 12px; cursor: pointer;
    font-family: inherit; min-height: 32px; max-width: 45vw;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.ip-pin-go:hover { background: #2f3a52; color: #fff; }
.ip-pin-x {
    background: #23283a; color: #667; border: 1px solid #3a4560;
    border-radius: 0 4px 4px 0; padding: 6px 8px; font-size: 11px; cursor: pointer;
    font-family: inherit; min-height: 32px; min-width: 28px;
}
.ip-pin-x:hover { background: #5c2a3c; color: #ff9eb0; }
.ip-pin-chip.is-current .ip-pin-go { color: #ffd866; border-color: #78683a; }
.ip-pin-chip.is-current .ip-pin-x { border-color: #78683a; }
/* Flat view: the file's folder, above the thumbnail. Tapping it drops back to
   folder view there. Fixed min-height so rows stay aligned when a top-level
   file shows the inert "/" instead. */
.ip-subpath {
    display: block; width: 100%; text-align: left; box-sizing: border-box;
    padding: 5px 8px; font-size: 10px; line-height: 1.3; min-height: 26px;
    color: #8a9bb5; background: transparent; border: 0;
    border-bottom: 1px solid #2a2a32;
    white-space: nowrap; text-overflow: ellipsis; overflow: hidden;
    font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace; cursor: pointer;
}
.ip-subpath:hover { color: #9ec6ff; background: #23232e; }
.ip-subpath.is-root { color: #555; cursor: default; }
.ip-subpath.is-root:hover { background: transparent; color: #555; }
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
/* Emitted by highlightMatches on the matched characters of a filename. */
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
