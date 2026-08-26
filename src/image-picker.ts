// image-picker.ts — opens a modal gallery picker on click of either:
//   - any upload-flag combo widget — stock LoadImage / LoadImageMask /
//     LoadImageOutput (`image_upload`), core LoadVideo (`video_upload`) and
//     core LoadAudio (`audio_upload`) — Input/Output/Temp tabs, writes
//     annotated values like "foo.png [output]" that
//     folder_paths.get_annotated_filepath resolves transparently.
//   - VHS's *upload* combo loaders (VHS_LoadVideo, VHS_LoadVideoFFmpeg,
//     VHS_LoadAudioUpload, VHS_LoadImages), matched by class name because VHS
//     builds those widgets from its own JS and leaves no marker on the input
//     spec. Same sandboxed tabs and same annotated values — VHS resolves them
//     through get_annotated_filepath too. VHS_LoadImages opens in directory
//     mode.
//   - any VHS path-loader's STRING widget (VHS_LoadImagePath,
//     VHS_LoadImagesPath, VHS_LoadVideoPath, VHS_LoadVideoFFmpegPath,
//     VHS_LoadAudio) —
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
  createScrollMemory,
  createViewStore,
  ensureStyleOnce,
  escapeHTML as escHTML,
  fuzzyScore,
  highlightMatches,
  IMG_EXTS,
  installBackGuard,
  installLazyMedia,
  installScrollRestore,
  isSafeViewActive,
  isSensitive,
  isValidSort,
  joinAbs,
  type MetaField,
  makeRevealButton,
  makeRevealSet,
  metaClipboardText,
  metaRows,
  nextRating,
  notify,
  onSafeViewChange,
  openModalShell,
  openShellOverlay,
  type PointerPatchableWidget,
  patchWidgetPointer,
  postRating,
  type RatingAddress,
  ratingOf,
  readSafeViewConfig,
  registerSafeViewHubToggle,
  SAFE_VIEW_GLYPH_OFF,
  SAFE_VIEW_GLYPH_ON,
  SANDBOXED_TYPES,
  type SafeViewConfig,
  SORT_OPTIONS,
  safeViewSettings,
  sensitiveKeyword,
  setBlurred,
  setSpoilered,
  sortFiles,
  starsHTML,
  toggleSafeView,
  VIDEO_EXTS,
  type ViewMode,
  warnRating,
} from "@laurigates/comfy-modal-kit";
import { app } from "/scripts/app.js";
import { hasSensitiveTag, markSensitiveHTML, postTag, TAG_URL } from "./safe-tag.js";

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

// IMG_EXTS / VIDEO_EXTS / SANDBOXED_TYPES come from the kit (0.14.0). They were
// hand-written here and byte-identically in comfyui-image-browser; both grids
// render the same files off the same disk, so a widened set in one pack and not
// the other shows a file as loadable in one grid and absent from the other.
//
// AUDIO_EXTS has no kit equivalent yet, so it lives here and MUST stay in step
// with `AUDIO_EXTS` in gallery_loader.py — the backend clamps /list to
// MEDIA_EXTS, so an extension this set asks for and that one lacks lists
// nothing, with no error to read. See issue #88's follow-up for promoting it
// into the kit alongside IMG_EXTS / VIDEO_EXTS.
const AUDIO_EXTS = new Set([".mp3", ".wav", ".ogg", ".oga", ".opus", ".flac", ".m4a", ".aac"]);

// Persisted sort preference. One shared key across every picker flavour so a
// user's "Name A→Z" choice sticks regardless of which node opened the modal.
const SORT_STORAGE_KEY = "comfyui-gallery-loader:sort";

// Per-directory scroll offsets. MODULE level, not per modal: that is what makes
// closing the picker and opening it again — on the same widget or another one —
// resume where you left off rather than at the top. A location never visited
// answers 0, which is why a first visit needs no special case.
//
// The store and the restore loop both come from the kit, shared with
// comfyui-image-browser so the two packs cannot drift on any of it. NOT
// persisted to localStorage, deliberately: an offset measured against a listing
// that may have changed while the tab was gone is a guess.
const scrollMemory = createScrollMemory();

// Flat ("all subfolders") view preference. The store comes from the kit
// (0.14.0); the NAMESPACE stays here, because it is the one thing that genuinely
// differs between this pack's copy and comfyui-image-browser's. The literal
// below must remain "comfyui-gallery-loader": the keys it derives —
// `comfyui-gallery-loader:view` and `comfyui-gallery-loader:view-pending` — are
// the ones every existing install already wrote, and changing the namespace
// orphans that stored preference silently while the UI still looks correct.
// Pinned by "the view store keeps THIS pack's literal storage keys" in
// tests/js/image-picker.test.js.
//
// The pending breadcrumb (`:view-pending`) is the load-bearing half: raised
// before a flat load and cleared once the grid has painted, so a flat attempt
// that killed the tab is detected at the next open and forced back to folder
// view rather than reopening straight into the same failure with no reachable
// toggle. That behaviour now lives in `createViewStore`.
const viewStore = createViewStore("comfyui-gallery-loader");

// ---- Pins ------------------------------------------------------------
//
// Folders AND individual media, in ONE list that lives on the SERVER
// (<user_dir>/comfy-pins.json via pins_store.py), not in localStorage. Two
// reasons the browser cannot own this list: a phone and a desktop are two
// browsers against one ComfyUI and localStorage structurally cannot span them,
// and comfyui-image-browser reads the same file so a pin set in either pack
// shows up in the other.
//
// The write API is a DELTA (add / remove / prune), never a whole-list PUT — two
// browsers with the picker open would each send their own full list and the
// second write would silently discard the first's pin. Both verbs answer with
// the whole freshly-resolved list, so a caller never needs a follow-up GET.
//
// Sandboxed roots only: a path-mode picker has no stable "type" to pin against,
// and the store rejects `type: "path"` outright.
//
// Staleness: there is NO watcher and we are not adding one. A file deleted or
// moved out of band is noticed the next time the list is fetched, which is
// every picker open and every navigation — the entry comes back with
// `exists: false` (never dropped: "the file moved" and "you never pinned it"
// are different facts), renders dimmed and inert, and "Prune missing" drops the
// whole set of them in one delta.
const PINS_URL = "/gallery_loader/pins";

// The synthetic tab that renders the pinned MEDIA. Deliberately not in
// SANDBOXED_TYPES: it is a view over several roots at once, not a root, so
// every "is this a sandboxed location?" gate (flat view, pin-this-folder,
// `recursive`) must stay false for it.
const PINNED_TYPE = "pinned";

// One pin's identity, as the store defines it. `name` is present iff
// kind === "file".
interface PinItem {
  kind: "dir" | "file";
  type: string;
  subfolder: string;
  name?: string;
}

// A pin as the endpoint answers it: the stored pin, plus `exists`, plus (for a
// resolvable file) the same per-file keys /list emits — which is what lets the
// pinned view render through the ordinary grid with no special-casing.
interface PinEntry {
  kind?: string;
  type?: string;
  subfolder?: string;
  name?: string;
  exists?: boolean;
  ext?: string;
  mtime?: number;
  size?: number;
  width?: number;
  height?: number;
  rating?: number;
}

// Must match pins_store.pin_key: (kind, type, subfolder, name), with name ""
// for a folder pin — so a folder and a file at the same address are different
// pins and cannot collide.
function pinKeyOf(p: PinEntry | PinItem): string {
  return `${p.kind ?? ""}:${p.type ?? ""}:${p.subfolder ?? ""}:${p.name ?? ""}`;
}

function pinLabel(p: PinEntry | PinItem): string {
  return `${p.type ?? ""}${p.subfolder ? `/${p.subfolder}` : ""}`;
}

function pinsOfResponse(data: Record<string, unknown>): PinEntry[] {
  return Array.isArray(data.pins) ? (data.pins as PinEntry[]) : [];
}

async function fetchPins(): Promise<PinEntry[]> {
  const r = await fetch(PINS_URL);
  const data = await r.json();
  if (!r.ok || !data?.ok) throw new Error(data?.error || `HTTP ${r.status}`);
  return pinsOfResponse(data);
}

async function postPinDelta(op: "add" | "remove" | "prune", item?: PinItem): Promise<PinEntry[]> {
  const body: Record<string, unknown> = { op };
  if (item) body.item = item;
  const r = await fetch(PINS_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  let data: Record<string, unknown> = {};
  try {
    data = await r.json();
  } catch {
    // fall through to the status-based error below
  }
  // The cap refusal ("pin limit reached (max 200)") arrives this way rather
  // than being clamped silently — an add that vanishes reads as a dead button.
  if (!r.ok || !data.ok) throw new Error((data.error as string) || `HTTP ${r.status}`);
  return pinsOfResponse(data);
}

// ---- One-shot migration off the old localStorage list -----------------
//
// The key is read here and nowhere else — there is no localStorage pin store
// any more, only this drain. Every old entry was a FOLDER pin, replayed as an
// `add` delta; `add_pin` treats an already-present pin as a successful no-op,
// so a second device migrating the same list (or a retry) is harmless.
const LEGACY_PINS_STORAGE_KEY = "comfyui-gallery-loader:pins";

let legacyPinMigration: Promise<void> | null = null;

async function runLegacyPinMigration(): Promise<void> {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(LEGACY_PINS_STORAGE_KEY);
  } catch {
    return; // private mode / disabled storage — nothing to migrate
  }
  if (!raw) return;
  try {
    const arr: unknown = JSON.parse(raw);
    if (Array.isArray(arr)) {
      for (const p of arr) {
        const pin = p as { type?: unknown; subfolder?: unknown };
        if (typeof pin?.subfolder !== "string") continue;
        if (!SANDBOXED_TYPES.includes(pin.type as string)) continue;
        await postPinDelta("add", {
          kind: "dir",
          type: pin.type as string,
          subfolder: pin.subfolder,
        });
      }
    }
  } catch (e) {
    // Leave the key in place so the next page load retries. A migration
    // failure must never keep the picker from opening.
    console.warn(`[${EXT_NAME}] pin migration failed — will retry next load`, e);
    return;
  }
  try {
    localStorage.removeItem(LEGACY_PINS_STORAGE_KEY);
  } catch {
    // Non-fatal.
  }
}

/** Idempotent per page: concurrent pickers share one migration run. */
function migrateLegacyPins(): Promise<void> {
  legacyPinMigration ??= runLegacyPinMigration();
  return legacyPinMigration;
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
    _origUploadFlag?: UploadFlag;
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
  _vhsComboEnhanced?: boolean;
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
  // The file's `dc:subject` keywords, read from its XMP in the same pass as
  // the rating. Absent (not empty) from a backend older than this key.
  tags?: string[];
  // Present only in a recursive ("flat") listing: the file's directory relative
  // to the requested subfolder, forward-slashed, "" for a top-level file. A
  // folder listing omits the key entirely. Never address a file with this
  // directly — go through fileSub(), which joins it onto state.subfolder.
  subpath?: string;
  // Pinned view only. Pins span ROOTS, so a pinned card cannot inherit
  // state.type the way a folder/flat card does — every per-file address goes
  // through fileType(), which reads this. Undefined outside the pinned view.
  pinType?: string;
  // Pinned view only: false when the pin no longer resolves. Such a card is
  // dimmed and inert (committing it would write a path that no longer exists);
  // it is not dropped, because "the file moved" and "you never pinned it" are
  // different facts.
  pinExists?: boolean;
}

// "loadimage" is the SANDBOXED flavour — Input/Output/Temp tabs over
// folder_paths' three roots, committing annotated values. The name predates
// video support; every node in this file that isn't a VHS *path* loader uses
// it, images and videos alike.
type PickerKind = "loadimage" | "vhs-path";
type PickerMode = "file" | "directory";

interface OpenOpts {
  kind: PickerKind;
  mode?: PickerMode;
  extensions?: string[];
  /** Modal heading. Defaults to a kind/mode-derived label. */
  title?: string;
}

interface SavedSort {
  key: string;
  dir: string;
}

function loadSavedSort(): SavedSort | null {
  try {
    const raw = localStorage.getItem(SORT_STORAGE_KEY);
    if (!raw || !isValidSort(raw)) return null;
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
  // Declares vhs_path_extensions ['wav','mp3','ogg','m4a','flac'] on its
  // `audio_file` STRING widget, so findVHSPathWidget already finds it and the
  // grid asks the backend for VHS's own set — nothing is hardcoded here.
  "VHS_LoadAudio",
]);

// VHS's *upload* loaders: plain combos over the input dir. Unlike the path
// loaders there is no `vhs_path_extensions` marker to detect — VHS builds
// these widgets from its own JS — so they are matched by class name.
//
// Each resolves its value with folder_paths.get_annotated_filepath (after
// VHS's strip_path), so the picker's `foo.mp4 [output]` form loads exactly
// like the bare input names the node's native dropdown offers.
interface VHSComboSpec {
  widget: string;
  mode: PickerMode;
  extensions?: string[];
  title: string;
  button: string;
}

// Mirrors VHS's own `video_extensions`
// (videohelpersuite/load_video_nodes.py) so the grid offers precisely what
// the node's native dropdown does — `.gif` included, which thumbForFile
// renders as an <img> because it is in IMG_EXTS. If VHS widens its list this
// goes stale silently; the symptom is a loadable file the grid won't show.
const VHS_VIDEO_EXTS = [".webm", ".mp4", ".mkv", ".gif", ".mov"];

// Mirrors VHS's own `audio_extensions` (videohelpersuite/nodes.py) the same
// way. `.mp4` is in it — VHS_LoadAudioUpload will pull the audio track out of a
// video container — so this is NOT our AUDIO_EXTS and must not be replaced by
// it: that would drop .mp4 from a dropdown the node itself offers.
const VHS_AUDIO_EXTS = [".mp3", ".mp4", ".wav", ".ogg"];

const VHS_COMBO_LOADERS = new Map<string, VHSComboSpec>([
  [
    "VHS_LoadVideo",
    {
      widget: "video",
      mode: "file",
      extensions: VHS_VIDEO_EXTS,
      title: "Choose video",
      button: "📁 Browse videos",
    },
  ],
  [
    "VHS_LoadVideoFFmpeg",
    {
      widget: "video",
      mode: "file",
      extensions: VHS_VIDEO_EXTS,
      title: "Choose video",
      button: "📁 Browse videos",
    },
  ],
  [
    "VHS_LoadAudioUpload",
    {
      widget: "audio",
      mode: "file",
      extensions: VHS_AUDIO_EXTS,
      title: "Choose audio",
      button: "📁 Browse audio",
    },
  ],
  // Loads every image in a directory, so the picker runs in directory mode:
  // files are inert and the footer commits the folder.
  [
    "VHS_LoadImages",
    { widget: "directory", mode: "directory", title: "Choose folder", button: "📁 Browse folders" },
  ],
]);

// Upload flags a combo may declare. Core LoadVideo declares `video_upload` and
// core LoadAudio `audio_upload` (io.UploadType.video / .audio); the frontend's
// WidgetSelect keys on the same flags to mount its Vue asset browser, which is
// why the defang below must strip all three.
const UPLOAD_FLAGS = ["image_upload", "video_upload", "audio_upload"] as const;
type UploadFlag = (typeof UPLOAD_FLAGS)[number];
type MediaKind = "image" | "video" | "audio";

const MEDIA_OF_FLAG: Record<UploadFlag, MediaKind> = {
  image_upload: "image",
  video_upload: "video",
  audio_upload: "audio",
};

// What each media kind asks the backend for, and how the modal names itself.
// `undefined` extensions means "the backend's default", which is images.
//
// Audio asks for AUDIO_EXTS *and* VIDEO_EXTS because core LoadAudio builds its
// own combo with filter_files_content_types(files, ["audio", "video"]) — it
// reads the audio track out of a video container — so an audio-only grid would
// hide files the node's native dropdown offers.
const MEDIA_PICKER: Record<MediaKind, { extensions?: string[]; title: string; button: string }> = {
  image: { title: "Choose image", button: "📁 Browse gallery" },
  video: { extensions: [...VIDEO_EXTS], title: "Choose video", button: "📁 Browse videos" },
  audio: {
    extensions: [...AUDIO_EXTS, ...VIDEO_EXTS],
    title: "Choose audio",
    button: "📁 Browse audio",
  },
};

// Fallbacks for when the defang never ran — an older frontend, or a node
// registered before our beforeRegisterNodeDef hook. Keyed on the widget the
// core node declares.
const CORE_LOADERS = new Map<string, { widget: string; media: MediaKind }>([
  ["LoadImage", { widget: "image", media: "image" }],
  ["LoadImageMask", { widget: "image", media: "image" }],
  ["LoadImageOutput", { widget: "image", media: "image" }],
  ["LoadVideo", { widget: "file", media: "video" }],
  ["LoadAudio", { widget: "audio", media: "audio" }],
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
// Upload-flag defang (core LoadImage / LoadVideo path)
// ============================================================
//
// Modern ComfyUI mounts a Vue WidgetSelect / Asset Browser component on any
// combo carrying an upload flag and routes the click through Vue — so
// widget.onPointerDown never fires. We work around that by stripping the flag
// from the input spec in beforeRegisterNodeDef, before the widget is
// constructed. With the flag gone the widget falls back to a plain LiteGraph
// canvas combo, which calls widget.onPointerDown as expected.
//
// WidgetSelect keys on `image_upload`, `video_upload`, `animated_image_upload`,
// `audio_upload` and `mesh_upload`; we strip only the three the picker can
// serve (see UPLOAD_FLAGS), so a mesh combo keeps its native control.
//
// Trade-off: the native "Upload" button is tied to the same flag, so it
// disappears too. The modal can grow its own upload action later.

function uploadFlagOfEntry(entry: unknown): UploadFlag | null {
  const opts =
    Array.isArray(entry) && entry.length >= 2
      ? entry[1]
      : entry && typeof entry === "object" && !Array.isArray(entry)
        ? entry
        : null;
  if (!opts || typeof opts !== "object") return null;
  const bag = opts as Record<string, unknown>;
  for (const flag of UPLOAD_FLAGS) {
    if (bag[flag] === true) return flag;
  }
  return null;
}

function defangNodeData(nodeData: NodeData | null | undefined): boolean {
  const inputs = nodeData?.input;
  if (!inputs) return false;
  let touched = false;
  for (const group of ["required", "optional"] as const) {
    const block = inputs[group];
    if (!block) continue;
    for (const [name, entry] of Object.entries(block)) {
      const flag = uploadFlagOfEntry(entry);
      if (!flag) continue;
      const opts = (Array.isArray(entry) ? entry[1] : entry) as Record<string, unknown>;
      opts[flag] = false;
      // Records WHICH flag was stripped, not merely that one was: it is the
      // only thing left on the widget that says whether this combo lists
      // images, videos or audio, and the three want different extension sets.
      opts._origUploadFlag = flag;
      touched = true;
      debug(`defanged ${flag} on ${nodeData?.name}.${name}`);
    }
  }
  return touched;
}

interface UploadWidget {
  w: PickerWidget;
  media: MediaKind;
}

function widgetNamed(node: PickerNode, name: string): PickerWidget | null {
  return node.widgets?.find((w) => w?.name === name) ?? null;
}

function findUploadWidget(node: PickerNode): UploadWidget | null {
  if (!node?.widgets) return null;
  for (const w of node.widgets) {
    const flag = w?.options?._origUploadFlag;
    if (flag) return { w, media: MEDIA_OF_FLAG[flag] };
  }
  // Defang didn't run (older frontend, or the node was registered before our
  // hook) — fall back to the core loaders by class name.
  const core = CORE_LOADERS.get(node.comfyClass || "") ?? CORE_LOADERS.get(node.type || "");
  if (!core) return null;
  const w = widgetNamed(node, core.widget);
  return w ? { w, media: core.media } : null;
}

// An annotated output/temp value isn't in the combo's values list (rebuilt
// from input/), so the canvas shows the literal text while the dropdown looks
// empty. Append it so the value validates against the combo's options.
function seedAnnotatedValue(w: PickerWidget): void {
  const v = (typeof w.value === "string" ? w.value : "").trim();
  if (!/\[(output|temp)\]\s*$/.test(v)) return;
  const values = w.options?.values;
  if (Array.isArray(values) && !values.includes(v)) values.push(v);
}

function addPickerHint(w: PickerWidget): void {
  const existing = w.options?.tooltip || "";
  const hint = "Click to open the gallery picker (or use the 📁 button below).";
  if (w.options) {
    w.options.tooltip = existing ? `${existing}\n\n${hint}` : hint;
  }
}

// Both click strategies, wired to one widget. A — patch widget.onPointerDown
// via the kit's chain-then-consume wrapper (falls back to the native control
// on error). B — an explicit button widget, which works regardless of
// frontend version and is the safety net if A's hook ever moves.
function wireOpeners(node: PickerNode, w: PickerWidget, buttonLabel: string, opts: OpenOpts): void {
  patchWidgetPointer(w as unknown as PointerPatchableWidget, (_pointer, ownerNode) => {
    openImagePicker(w, (ownerNode as PickerNode) || node, opts);
    return true;
  });
  appendButtonWidget(
    node as ButtonWidgetHost,
    buttonLabel,
    () => {
      openImagePicker(w, node, opts);
    },
    { logPrefix: EXT_NAME },
  );
}

function enhanceUploadComboNode(node: PickerNode): void {
  if (!node?.widgets) return;
  if (node._galleryPickerEnhanced) return;
  const found = findUploadWidget(node);
  if (!found) return;
  const { w, media } = found;
  node._galleryPickerEnhanced = true;

  seedAnnotatedValue(w);

  debug(`enhancing ${node.comfyClass || node.type}:`, {
    widgetName: w.name,
    widgetType: w.type,
    media,
  });

  addPickerHint(w);
  const picker = MEDIA_PICKER[media];
  wireOpeners(node, w, picker.button, {
    kind: "loadimage",
    // Images are the backend's default listing, so only the video and audio
    // flavours carry an extension set.
    extensions: picker.extensions,
    title: picker.title,
  });
}

// ============================================================
// VHS upload-combo hook (class-name matched)
// ============================================================

function enhanceVHSComboNode(node: PickerNode): void {
  if (!node?.widgets) return;
  if (node._vhsComboEnhanced) return;
  const spec = VHS_COMBO_LOADERS.get(node.comfyClass || "");
  if (!spec) return;
  const w = widgetNamed(node, spec.widget);
  if (!w) return;
  node._vhsComboEnhanced = true;

  seedAnnotatedValue(w);

  debug(`enhancing VHS combo ${node.comfyClass}:`, {
    widgetName: w.name,
    mode: spec.mode,
  });

  addPickerHint(w);
  wireOpeners(node, w, spec.button, {
    kind: "loadimage",
    mode: spec.mode,
    extensions: spec.extensions,
    title: spec.title,
  });
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

// A sandboxed DIRECTORY value (VHS_LoadImages). Same annotated grammar as a
// file value, but the whole relative part is the folder — so "a/b [output]"
// opens inside output/a/b rather than treating "b" as a filename. "." means
// the root itself (see commitFolder).
function parseLoadImageDirValue(v: unknown): { type: string; subfolder: string } {
  const s = (typeof v === "string" ? v : "").trim();
  if (!s) return { type: "input", subfolder: "" };
  const ann = s.match(/^(.*?)\s*\[(input|output|temp)\]\s*$/);
  const rel = (ann ? (ann[1] as string) : s).replace(/\\/g, "/").replace(/^\.?\/*|\/+$/g, "");
  return { type: ann ? (ann[2] as string) : "input", subfolder: rel };
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
  // workflows don't churn on save/reload: this widget is core LoadImage's
  // native COMBO, whose options are `sorted(files)` off the input dir with no
  // annotation, so a bare value matches an option the widget already has.
  //
  // The inline node grid does the OPPOSITE and annotates input too — see the
  // long note above `buildAnnotated` in gallery_loader.ts for why that is
  // right there (a STRING widget with no option list) and wrong here. Both
  // forms resolve the same through get_annotated_filepath; the divergence is
  // about which widget is being written, not about resolution.
  return type === "input" ? rel : `${rel} [${type}]`;
}

// `joinAbs` is the kit's (0.14.0) — the same three lines lived here and in
// comfyui-image-browser, and both feed a `?path=` the backend resolves.

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

// `MetaField`, `MetaRow`, `metaRows` and `metaClipboardText` come from the kit
// (0.14.0), along with the fixed `META_FIELDS` display order they walk. Both
// packs' /metadata endpoints answer the same summary keys, and the ORDER is the
// thing worth single-sourcing: rendering the response's own key order lays the
// same image out differently depending on which tool wrote the file.
//
// `ImageMetadata` stays here — it is the shape of THIS pack's
// /gallery_loader/metadata response, not a shared display concern.
interface ImageMetadata {
  format: string;
  source: string;
  summary: Partial<Record<MetaField, unknown>>;
  raw: Record<string, string>;
  truncated: boolean;
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
  kind: "img" | "video" | "audio" | "icon";
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

  const savedView = viewStore.load();
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

  // Sibling of fileSub(). In folder/flat view every card lives under
  // state.type; in the pinned view each card carries its own root, because pins
  // span roots. Every per-file address (thumbnail, rating, metadata, committed
  // value, the subpath label's target) pairs this with fileSub(), never
  // state.type — which is the VIEW's location, not the file's.
  function fileType(f: ListingFile): string {
    return f.pinType ?? state.type;
  }

  // The pinned view is a listing of several roots at once, so it is not a
  // sandboxed location: flat view, `recursive` and pin-this-folder all stay off.
  function isPinned(): boolean {
    return state.type === PINNED_TYPE;
  }

  let initialSnapshot: InitialSnapshot;
  if (kind === "loadimage") {
    // Directory mode wants no files at all; the backend intersects this
    // sentinel with its media set to nothing, leaving only folders.
    state.extensionsParam =
      mode === "directory"
        ? [".__none__"]
        : extensions?.length
          ? extensions.map((e) => (e.startsWith(".") ? e : `.${e}`))
          : null;
    if (mode === "directory") {
      const init = parseLoadImageDirValue(widget.value);
      state.type = init.type;
      state.subfolder = init.subfolder;
      initialSnapshot = { type: init.type, subfolder: init.subfolder, name: "" };
    } else {
      const init = parseLoadImageValue(widget.value);
      state.type = init.type;
      state.subfolder = init.subfolder;
      state.currentName = init.name;
      initialSnapshot = { type: init.type, subfolder: init.subfolder, name: init.name };
    }
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
    opts.title ??
    (mode === "directory"
      ? "Choose folder"
      : kind === "loadimage"
        ? "Choose image"
        : "Choose file");

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
    onClose: () => {
      // FIRST, and through the restorer's mirror: the shell has already
      // removed the dialog by the time onClose runs, and a detached element
      // answers scrollTop 0 in every real engine. Reading modal.bodyEl here
      // would store 0 and silently reopen the picker at the top.
      rememberScroll();
      // …and only then drop the restorer's listeners and cancel a re-assert
      // loop that may still be running against the detached dialog. Nothing
      // scheduled may outlive the modal.
      scroller.dispose();
      disposeBackGuard?.();
      disposeBackGuard = null;
      // Nothing scheduled may outlive the modal: the change listener closes
      // over gridEl and repaints, so a surviving subscription would repaint a
      // detached grid on every settings change for the rest of the session —
      // one leaked listener per modal open.
      disposeSafeViewSub?.();
      disposeSafeViewSub = null;
      // Reveals are per modal SESSION. Not clearing here would carry a reveal
      // into the next open of the picker, which is exactly the "someone else
      // walked up" case the filter exists for.
      revealSet.clear();
    },
  });

  // ---- Scroll restore --------------------------------------------
  // `.cmp-body` is the shell's overflow-y:auto region and therefore the one
  // element that actually scrolls — `.ip-grid` has no overflow clip, the same
  // fact that decides installLazyMedia's root just below.
  //
  // Everything about WHY a remembered offset is not one assignment lives in
  // comfy-modal-kit/src/scroll-restore.ts: the close path reads a detached
  // element, `scrollTop = n` clamps against the layout in force at that
  // instant, iOS momentum keeps decelerating after the finger is up, and a
  // restore that outlives the user's next gesture swallows it. All four were
  // measured in comfyui-image-browser's browser suite; this pack now has one
  // of its own (tests/e2e) rather than a comment explaining why it could not
  // do this.
  //
  // No isTypingTarget override: the kit's default already reads "the focused
  // element is a text field", which covers the shell's autofocused search
  // input — the case that matters, since a caret key there must not read as a
  // scroll gesture and disarm the restore on every keystroke of a filter.
  const scroller = installScrollRestore(modal.bodyEl);

  /**
   * Store the current offset under the CURRENT location, before it changes.
   *
   * Every navigation calls this first; so does onClose. It reads through the
   * restorer, never `modal.bodyEl.scrollTop` — see the note in onClose.
   */
  function rememberScroll(): void {
    scrollMemory.remember(locationKey(), scroller.current());
  }

  // ---- Safe View --------------------------------------------------
  //
  // DISCRETION, NOT ACCESS CONTROL: the blur is a CSS class and the blurred
  // bytes are still fetched and cached. It defeats a glance over the shoulder,
  // not anyone with the keyboard or devtools.
  //
  // Reveals are held for the modal session and dropped on close and on any
  // tab/folder change (see loadAndRender) — a delete-triggered re-render must
  // not re-blur the card you were just looking at, while navigating away is a
  // deliberate change of context and resets.
  const revealSet = makeRevealSet();
  let disposeSafeViewSub: (() => void) | null = null;

  /**
   * The LOGICAL folder address of a file, matching what the backend builds:
   * `output/nsfw/2026-08-04` for a sandboxed root, the absolute directory for
   * a path picker. `fileSub()` alone returns the bare SUBFOLDER, so passing it
   * through unprefixed would drop the root segment and a keyword of `output`
   * or `temp` would silently match nothing.
   */
  function safeViewPath(f: ListingFile): string {
    if (state.type === "path") return state.absPath || "";
    const sub = fileSub(f);
    const root = fileType(f);
    return sub ? `${root}/${sub}` : root;
  }

  /** Whether this card matches the filter AND the user has not revealed it. */
  function isHiddenCard(f: ListingFile, cfg: SafeViewConfig): boolean {
    if (!isSensitive({ name: f.name, path: safeViewPath(f), tags: f.tags }, cfg)) return false;
    return !revealSet.has(fileType(f), fileSub(f), f.name);
  }

  /**
   * The element to blur: the MEDIA inside the thumbnail, never the thumbnail
   * itself. `.ip-thumb` also hosts the ⓘ and 📌 overlay buttons and the reveal
   * button below, and `filter` blurs an element's whole subtree — blurring the
   * container would smear the very controls the user needs to act on the card.
   * `.ip-thumb`'s `overflow: hidden` already clips the blur's 1.08 scale-up.
   *
   * Returns null for a folder card, whose thumbnail IS the generic 📁 glyph:
   * that glyph carries no information about what is being hidden, so there is
   * nothing to blur there. The folder's NAME is the sensitive part, and that is
   * spoilered like any other.
   */
  function safeViewMediaEl(card: HTMLElement): Element | null {
    return card.querySelector(".ip-thumb img, .ip-thumb video, .ip-thumb > .ip-thumb-icon");
  }

  /**
   * Paint one card as hidden: blur the image, block out every label that
   * carries the name, and add the per-card reveal.
   *
   * The reveal button goes in `.ip-thumb` — which is deliberately NOT the
   * element being blurred, so the button stays sharp and tappable.
   */
  function applySafeView(card: HTMLElement, cfg: SafeViewConfig, onReveal: () => void): void {
    card.classList.add("is-safe-hidden");
    const media = safeViewMediaEl(card);
    if (media) setBlurred(media, true);
    if (cfg.blurNames) {
      // setSpoilered also REMOVES the title attribute (parking it for restore).
      // That matters more than the paint: a native tooltip renders the full
      // name on hover regardless of any CSS, so a spoiler that only draws a
      // block leaks the exact string it was hiding to anyone who rests a
      // pointer on the card.
      for (const el of card.querySelectorAll(".ip-name, .ip-subpath")) setSpoilered(el, true);
    }
    const host = card.querySelector(".ip-thumb") ?? card;
    host.appendChild(makeRevealButton({ onReveal }));
  }

  // ---- Android / gesture back ------------------------------------
  // A sentinel history entry keeps the hardware back button acting on the
  // picker instead of navigating away from ComfyUI. The kit owns the history
  // bookkeeping; what "back" MEANS here is this callback: dismiss an open
  // overlay (the metadata card), else ascend one directory, and only close at
  // a root. Assigned after the shell exists because onClose above closes over
  // it, and the guard needs `modal` to hit-test the overlay.
  let disposeBackGuard: (() => void) | null = null;

  function canGoUp(): boolean {
    return state.type === "path" ? !!state.absPath && state.absPath !== "/" : !!state.subfolder;
  }

  disposeBackGuard = installBackGuard(() => {
    if (modal.dialog.querySelector(".cmp-ov-backdrop")) {
      // Route through the overlay's own ESC path so its onDismiss fires and
      // the shell's key handler is restored — closing it by hand would leave
      // the overlay's suspended ESC listener unrestored.
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", cancelable: true }));
      return true;
    }
    if (canGoUp()) {
      navigateUp();
      return true;
    }
    modal.close();
    return false;
  });

  // ---- Toolbar: tabs (loadimage only) + breadcrumbs + sort + refresh -
  let tabsEl: HTMLElement | null = null;
  if (kind === "loadimage") {
    tabsEl = document.createElement("div");
    tabsEl.className = "ip-tabs";
    // The pinned tab is a MEDIA view, so it has nothing to offer a directory
    // picker (file cards are inert there and the modal commits a folder) — it
    // is not created at all rather than created-then-hidden, same discipline as
    // the flat toggle.
    const tabTypes =
      mode === "directory" ? [...SANDBOXED_TYPES] : [...SANDBOXED_TYPES, PINNED_TYPE];
    for (const t of tabTypes) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "ip-tab";
      b.dataset.type = t;
      b.textContent = t === PINNED_TYPE ? "📌 pinned" : t;
      tabsEl.appendChild(b);
    }
    modal.toolbarEl.appendChild(tabsEl);
  }

  const crumbsEl = document.createElement("div");
  crumbsEl.className = "ip-crumbs";

  const sortEl = document.createElement("select");
  sortEl.className = "ip-control";
  sortEl.title = "Sort";
  // Options come from the kit so both surfaces offer — and accept — the same
  // ten, which is what makes sharing the :sort key safe.
  sortEl.innerHTML = SORT_OPTIONS.map(
    (o) => `<option value="${o.value}">${escHTML(o.label)}</option>`,
  ).join("");
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
  let pruneEl: HTMLButtonElement | null = null;
  if (kind === "loadimage") {
    pinToggleEl = document.createElement("button");
    pinToggleEl.type = "button";
    pinToggleEl.className = "ip-control ip-icon ip-pin-toggle";
    pinToggleEl.title = "Pin this folder";
    pinToggleEl.textContent = "📌";
    pruneEl = document.createElement("button");
    pruneEl.type = "button";
    pruneEl.className = "ip-control ip-prune";
    pruneEl.title = "Drop every pin that no longer resolves";
    pruneEl.textContent = "Prune missing";
    pruneEl.style.display = "none";
    pinsEl = document.createElement("div");
    pinsEl.className = "ip-pins";
  }

  // Safe View toggle. Always created: unlike the flat/pin controls it is
  // meaningful on every flavour of the picker, including a path browse and
  // directory mode (a folder card can match by name too).
  const safeViewEl = document.createElement("button");
  safeViewEl.type = "button";
  safeViewEl.className = "ip-control ip-icon ip-safe-view";

  function renderSafeViewToggle(): void {
    const on = isSafeViewActive();
    safeViewEl.textContent = on ? SAFE_VIEW_GLYPH_ON : SAFE_VIEW_GLYPH_OFF;
    safeViewEl.classList.toggle("is-active", on);
    safeViewEl.title = on
      ? "Safe View on — matching thumbnails are blurred. Tap to show everything."
      : "Safe View off — tap to blur thumbnails matching your keywords.";
    safeViewEl.setAttribute("aria-pressed", String(on));
  }
  renderSafeViewToggle();
  safeViewEl.addEventListener("click", () => {
    // The kit writes through the setting store, which fires onChange, which
    // fires our subscription below — so there is deliberately no repaint here.
    toggleSafeView();
  });

  modal.toolbarEl.append(
    crumbsEl,
    ...(viewToggleEl ? [viewToggleEl] : []),
    ...(pinToggleEl ? [pinToggleEl] : []),
    ...(pruneEl ? [pruneEl] : []),
    safeViewEl,
    sortEl,
    refreshEl,
    ...(pinsEl ? [pinsEl] : []),
  );

  // ---- Pin cache --------------------------------------------------
  //
  // The whole list, refreshed from every GET *and* every POST (both answer with
  // it), so render-time "is this pinned?" is synchronous — a per-card GET would
  // be one request per thumbnail. A failed request degrades to an empty cache,
  // i.e. "no chips", rather than throwing out of a render.
  let pinEntries: PinEntry[] = [];
  let pinKeys = new Set<string>();

  function adoptPins(entries: PinEntry[]): void {
    pinEntries = entries;
    pinKeys = new Set(entries.map(pinKeyOf));
  }

  async function refreshPins(): Promise<void> {
    try {
      await migrateLegacyPins();
      adoptPins(await fetchPins());
    } catch (e) {
      console.warn(`[${EXT_NAME}] pin list unavailable`, e);
      adoptPins([]);
    }
  }

  /** Apply one delta and adopt the list it answers with. False on refusal. */
  async function applyPinDelta(op: "add" | "remove" | "prune", item?: PinItem): Promise<boolean> {
    try {
      adoptPins(await postPinDelta(op, item));
    } catch (e) {
      console.warn(`[${EXT_NAME}] pin ${op} failed`, e);
      notify({
        severity: "warn",
        summary: op === "remove" ? "Pin not removed" : "Pin not saved",
        detail: String((e as Error)?.message ?? e),
      });
      return false;
    }
    renderPins();
    return true;
  }

  function filePinItem(f: ListingFile): PinItem {
    return { kind: "file", type: fileType(f), subfolder: fileSub(f), name: f.name };
  }

  function isFilePinned(f: ListingFile): boolean {
    return pinKeys.has(pinKeyOf(filePinItem(f)));
  }

  async function toggleFilePin(f: ListingFile, btn: HTMLButtonElement): Promise<void> {
    const item = filePinItem(f);
    if (!(await applyPinDelta(pinKeys.has(pinKeyOf(item)) ? "remove" : "add", item))) return;
    if (isPinned()) {
      // Unpinning from the pinned tab removes the card, so the grid repaints.
      applyPinnedListing();
      renderGrid();
      return;
    }
    // Elsewhere only this one button changed — repainting the whole grid would
    // throw away the user's scroll position mid-browse.
    const nowPinned = pinKeys.has(pinKeyOf(item));
    btn.classList.toggle("is-pinned", nowPinned);
    btn.title = nowPinned ? "Unpin this file" : "Pin this file";
    btn.setAttribute("aria-pressed", String(nowPinned));
  }

  function renderPins(): void {
    if (!pinToggleEl || !pinsEl) return;
    // Chips are the FOLDER pins; the file pins live in the pinned tab's grid.
    // The SANDBOXED_TYPES filter is belt-and-braces over pins_store's own
    // rejection of `type: "path"`: a chip whose type the click handler refuses
    // would render as a dead control, and the store is a plain JSON file two
    // packs and a human with ssh can write.
    const dirs = pinEntries.filter(
      (p) => p.kind === "dir" && SANDBOXED_TYPES.includes(p.type ?? ""),
    );
    const canPin = SANDBOXED_TYPES.includes(state.type);
    pinToggleEl.style.display = canPin ? "" : "none";
    const herePinned =
      canPin &&
      pinKeys.has(pinKeyOf({ kind: "dir", type: state.type, subfolder: state.subfolder }));
    pinToggleEl.classList.toggle("is-active", herePinned);
    pinToggleEl.title = herePinned ? "Unpin this folder" : "Pin this folder";
    if (pruneEl) {
      // Only offered where the stale pins are visible, and only when there is
      // something to prune.
      const anyMissing = pinEntries.some((p) => p.exists === false);
      pruneEl.style.display = isPinned() && anyMissing ? "" : "none";
    }
    pinsEl.innerHTML = "";
    // The chip row stays visible on the pinned tab — it is how you leave.
    pinsEl.style.display = dirs.length ? "" : "none";
    for (const p of dirs) {
      const chip = document.createElement("span");
      chip.className = "ip-pin-chip";
      chip.dataset.pinType = p.type ?? "";
      chip.dataset.pinSub = p.subfolder ?? "";
      if (p.type === state.type && (p.subfolder ?? "") === state.subfolder) {
        chip.classList.add("is-current");
      }
      if (p.exists === false) {
        chip.classList.add("is-missing");
      }
      const go = document.createElement("button");
      go.type = "button";
      go.className = "ip-pin-go";
      go.title = p.exists === false ? `${pinLabel(p)} — folder is missing` : `Go to ${pinLabel(p)}`;
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
    // A new filter reads from the top. Handed in rather than assigned after,
    // for the same reason as in loadAndRender: renderGrid's restore defends the
    // offset it was given for a few frames.
    renderGrid({ scrollTo: 0 });
  });

  sortEl.addEventListener("change", () => {
    const [k, d] = sortEl.value.split(":");
    state.sortKey = k as string;
    state.sortDir = d as string;
    saveSort(k as string, d as string);
    renderGrid({ scrollTo: 0 });
  });

  refreshEl.addEventListener("click", () => loadAndRender({ preserveScroll: true }));

  pinToggleEl?.addEventListener("click", () => {
    if (!SANDBOXED_TYPES.includes(state.type)) return;
    const item: PinItem = { kind: "dir", type: state.type, subfolder: state.subfolder };
    void applyPinDelta(pinKeys.has(pinKeyOf(item)) ? "remove" : "add", item);
  });

  pinsEl?.addEventListener("click", (e) => {
    const t = e.target as HTMLElement;
    const chip = t.closest("[data-pin-type]") as HTMLElement | null;
    if (!chip) return;
    const type = chip.dataset.pinType as string;
    if (!SANDBOXED_TYPES.includes(type)) return;
    const item: PinItem = { kind: "dir", type, subfolder: chip.dataset.pinSub || "" };
    if (t.closest(".ip-pin-x")) {
      void applyPinDelta("remove", item);
      return;
    }
    if (item.type === state.type && item.subfolder === state.subfolder) return;
    rememberScroll();
    state.type = item.type;
    state.subfolder = item.subfolder;
    loadAndRender();
  });

  pruneEl?.addEventListener("click", () => {
    void applyPinDelta("prune").then((ok) => {
      // The pinned grid IS the pruned list, so it has to repaint; elsewhere the
      // chips renderPins() already refreshed are the only visible change.
      if (ok && isPinned()) {
        applyPinnedListing();
        renderGrid();
      }
    });
  });

  viewToggleEl?.addEventListener("click", () => {
    if (!SANDBOXED_TYPES.includes(state.type)) return;
    // The folder and flat listings of one directory are different lists, and
    // locationKey() gives them separate slots — so each keeps its own place.
    rememberScroll();
    state.viewMode = state.viewMode === "flat" ? "folder" : "flat";
    viewStore.save(state.viewMode);
    // Flat needs a recursive re-fetch, so this is a reload, not a re-render.
    loadAndRender();
  });

  if (tabsEl) {
    tabsEl.addEventListener("click", (e) => {
      const b = (e.target as HTMLElement).closest("[data-type]") as HTMLElement | null;
      if (!b) return;
      if (state.type === b.dataset.type) return;
      rememberScroll();
      state.type = b.dataset.type as string;
      state.subfolder = "";
      loadAndRender();
    });
  }

  crumbsEl.addEventListener("click", (e) => {
    const c = (e.target as HTMLElement).closest("[data-sub], [data-abs]") as HTMLElement | null;
    if (!c) return;
    rememberScroll();
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

  // Card 📌 toggles a FILE pin. Same shape as the star handler above: it stops
  // propagation and the card handler below early-returns, so a pin tap never
  // commits the value and closes the modal.
  gridEl.addEventListener("click", (e) => {
    const btn = (e.target as HTMLElement).closest(".ip-pin-file") as HTMLButtonElement | null;
    if (!btn) return;
    e.stopPropagation();
    const card = btn.closest(".ip-card") as HTMLElement | null;
    if (!card) return;
    const f = fileOfCard(card);
    if (!f) return;
    void toggleFilePin(f, btn);
  });

  // 🙈 writes the Safe View keyword into the file's dc:subject. Same shape as
  // the star and pin handlers: stops propagation so the card handler below
  // never commits the value and closes the modal on a mark tap.
  gridEl.addEventListener("click", (e) => {
    const btn = (e.target as HTMLElement).closest(".ip-mark-sensitive") as HTMLButtonElement | null;
    if (!btn) return;
    e.stopPropagation();
    const card = btn.closest(".ip-card") as HTMLElement | null;
    if (!card) return;
    const f = fileOfCard(card);
    if (!f) return;
    void toggleSensitiveTag(f, btn);
  });

  gridEl.addEventListener("click", (e) => {
    const target = e.target as HTMLElement;
    if (
      target.closest(".ip-star") ||
      target.closest(".ip-pin-file") ||
      target.closest(".ip-mark-sensitive")
    )
      return;
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
      // The subpath label jumps to that folder in folder view. In the pinned
      // view it also carries the pin's own ROOT, because the label there is a
      // full address (`output/2026-08-04/`) rather than a subpath under the
      // current tab.
      const subEl = target.closest(".ip-subpath") as HTMLElement | null;
      if (subEl?.dataset.sub !== undefined) {
        e.stopPropagation();
        rememberScroll();
        state.viewMode = "folder";
        viewStore.save("folder");
        if (subEl.dataset.pinType) state.type = subEl.dataset.pinType;
        state.subfolder = subEl.dataset.sub || "";
        loadAndRender();
        return;
      }
      const f = fileOfCard(card);
      if (!f) return;
      // A pin whose file no longer resolves must not commit: the value would
      // address a path that isn't there. Say so and leave the modal open, with
      // the card's own 📌 as the unpin affordance.
      if (f.pinExists === false) {
        notify({
          severity: "warn",
          summary: "That file is gone",
          detail: `${fileType(f)}/${fileSub(f) ? `${fileSub(f)}/` : ""}${f.name} no longer resolves. Unpin it with 📌, or use "Prune missing".`,
        });
        return;
      }
      commitFile(f);
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
      data = await fetchMetadata(fileType(f), fileSub(f), f.name, state.absPath);
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
  /**
   * The per-file write address. `fileType`/`fileSub` and never `state.type` —
   * pins span roots, so a pinned card's own root is the only correct one.
   * Shared by the rating and keyword writes so the two cannot drift into
   * addressing the same card differently.
   */
  function addressOf(f: ListingFile): RatingAddress {
    return {
      type: fileType(f),
      subfolder: fileSub(f),
      absDir: state.absPath,
      name: f.name,
    };
  }

  function setStarRating(f: ListingFile, row: HTMLElement, next: number): void {
    const prev = Number(row.dataset.rating || "0");
    applyStars(row, next);
    f.rating = next;
    postRating(RATING_URL, addressOf(f), next)
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

  /**
   * Add or remove the Safe View keyword on one file.
   *
   * Takes the file OBJECT for the same reason `setStarRating` does — a name
   * lookup addresses the wrong file in flat view — and re-renders on success
   * rather than patching the button: marking a file is exactly the event that
   * should make it blur, and the reveal set has not been touched, so it does.
   *
   * The button is disabled for the duration. It flips the file's state on the
   * server, so a double tap is a second write racing the first, and the loser
   * decides what the file ends up carrying.
   */
  async function toggleSensitiveTag(f: ListingFile, btn: HTMLButtonElement): Promise<void> {
    const cfg = readSafeViewConfig();
    const keyword = sensitiveKeyword(cfg);
    if (!keyword) return; // no configured keyword — the button should not exist
    const next = !hasSensitiveTag(f, keyword);
    btn.disabled = true;
    try {
      // The server answers with the keywords it read back AFTER writing, so
      // this is the file's real state, not an echo of the request.
      f.tags = await postTag(TAG_URL, addressOf(f), keyword, next);
      renderGrid();
    } catch (e) {
      notify({
        severity: "warn",
        summary: next ? "Not marked" : "Not unmarked",
        detail: String((e as Error)?.message ?? e),
      });
      btn.disabled = false;
    }
  }

  function navigateUp(): void {
    rememberScroll();
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
    rememberScroll();
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
    // Server-side hide. Sent ONLY when the user asked for hiding and there is
    // something to match with, so the default request URL is byte-identical to
    // what it has always been and every existing listing test is untouched.
    const kw = safeHideKeywords();
    if (kw) {
      p.set("safe_kw", kw);
      p.set("safe_hide", "1");
    }
    return `${LIST_URL}?${p.toString()}`;
  }

  /**
   * The keyword string to send for server-side hiding, or "" when hiding is
   * off. Doubles as the LISTING SIGNATURE: when it changes, the set of rows the
   * server would return has changed, so a repaint is not enough — the grid has
   * to be re-fetched. Reading it once, in one place, is what keeps the request
   * and the reload decision from drifting apart.
   */
  function safeHideKeywords(): string {
    const cfg = readSafeViewConfig();
    return cfg.hide && isSafeViewActive(cfg) ? cfg.keywords.join(",") : "";
  }

  function numOr0(v: unknown): number {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  }

  // One pin entry as a grid file. An `exists: false` entry carries no stats at
  // all, so every numeric field is normalised to 0 — a bare `Number(undefined)`
  // is NaN, and one NaN mtime makes sortFiles produce an arbitrary ordering for
  // the WHOLE list, not just that card.
  function pinToListingFile(p: PinEntry): ListingFile {
    const name = String(p.name ?? "");
    const dot = name.lastIndexOf(".");
    return {
      name,
      ext: (p.ext ?? (dot > 0 ? name.slice(dot) : "")).toLowerCase(),
      mtime: numOr0(p.mtime),
      size: numOr0(p.size),
      width: numOr0(p.width),
      height: numOr0(p.height),
      rating: numOr0(p.rating),
      // fileSub() joins this onto state.subfolder, which is "" on the pinned
      // tab — so a card's effective subfolder is exactly its pin's.
      subpath: p.subfolder ?? "",
      pinType: p.type ?? "",
      pinExists: p.exists !== false,
    };
  }

  // Renders straight out of the pin cache: the GET already resolved every entry
  // and a file pin carries the same per-file keys /list emits.
  function applyPinnedListing(): void {
    state.dirs = [];
    state.files = pinEntries.filter((p) => p.kind === "file").map(pinToListingFile);
    modal.setStatus("");
  }

  // The location the reveal set belongs to, and the listing signature the last
  // fetch was made with. Both are compared, never assumed.
  let revealLocation: string | null = null;
  let lastSafeHideKeywords = safeHideKeywords();

  /** Identifies the tab/folder being shown. A change resets the reveals. */
  function locationKey(): string {
    return state.type === "path"
      ? `path:${state.absPath}`
      : `${state.type}:${state.subfolder}:${isFlat() ? "flat" : "folder"}`;
  }

  // Repaint (or re-fetch) every open picker when the shared setting changes —
  // including when the change came from the OTHER gallery pack, since both
  // register the same setting ids and the listeners live on the kit's shared
  // rendezvous.
  disposeSafeViewSub = onSafeViewChange(() => {
    renderSafeViewToggle();
    const kw = safeHideKeywords();
    if (kw !== lastSafeHideKeywords) {
      // The server would now return a different SET of rows, so a repaint of
      // the rows we already have would show a stale listing — notably when
      // hiding is switched OFF, where the hidden files are simply not in
      // `state.files` to un-blur.
      void loadAndRender({ preserveScroll: true });
      return;
    }
    renderGrid();
  });

  async function loadAndRender(opts?: { preserveScroll?: boolean }): Promise<void> {
    lastSafeHideKeywords = safeHideKeywords();
    // Reveals are dropped on a tab/folder change but survive a plain refresh
    // and a delete-triggered re-render, which is why this compares the location
    // rather than clearing on every load.
    const here = locationKey();
    if (revealLocation !== null && revealLocation !== here) revealSet.clear();
    revealLocation = here;
    renderTabs();
    renderCrumbs();
    renderViewToggle();
    renderPins();
    modal.setBusy(true);
    modal.setStatus("Loading…");
    viewStore.markPending(isFlat());
    // In flight alongside the listing: the chips are shown on every tab, so the
    // list is refreshed on every load rather than only when the pinned tab is
    // open — that is also what keeps a pin made on another device visible here.
    const pinsDone = refreshPins();
    if (isPinned()) {
      await pinsDone;
      applyPinnedListing();
    } else {
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
            detail:
              "This folder has more files than the listing returns; older ones are not shown.",
          });
        }
      } catch (e) {
        console.error(`[${EXT_NAME}] list failed:`, e);
        modal.setStatus(`Error: ${(e as Error).message}`);
        state.dirs = [];
        state.files = [];
      }
      await pinsDone;
    }
    modal.setBusy(false);
    // Re-run now that the pin cache has landed — the call at the top of this
    // function painted the PREVIOUS list. Before the grid, because the chips
    // render into the toolbar INSIDE the scroller, so painting them afterwards
    // would move the content under an offset just restored.
    renderPins();
    // A navigation lands at the destination's remembered offset (0 for a folder
    // never visited); a refresh-in-place keeps whatever renderGrid captures.
    //
    // Handed INTO renderGrid rather than assigned after it: renderGrid would
    // otherwise capture and re-assert the offset belonging to the folder we
    // just LEFT, and a follow-up write would race that loop for ~200 ms.
    renderGrid({
      scrollTo: opts?.preserveScroll ? undefined : scrollMemory.get(locationKey()),
    });
    // Cleared only once the grid has actually painted — that is what makes a
    // still-set flag at open time mean "the last flat load never finished".
    viewStore.markPending(false);
  }

  function thumbForFile(f: ListingFile): ThumbDescriptor {
    const ext = (f.ext || "").toLowerCase();
    // A pin that no longer resolves has no thumbnail to fetch — every URL we
    // could build 404s, so say so rather than firing a request per dead card.
    if (f.pinExists === false) {
      return { kind: "icon", text: "⚠" };
    }
    const type = fileType(f);
    if (type === "path") {
      if (IMG_EXTS.has(ext)) {
        return { kind: "img", src: imageThumbURLAbs(state.absPath, f) };
      }
      if (VIDEO_EXTS.has(ext)) {
        return { kind: "video", src: videoSrcURL("path", "", f.name, state.absPath) };
      }
      if (AUDIO_EXTS.has(ext)) {
        return { kind: "audio" };
      }
      return { kind: "icon", text: "📄" };
    }
    const sub = fileSub(f);
    if (IMG_EXTS.has(ext)) {
      return { kind: "img", src: imageThumbURL(type, sub, f) };
    }
    if (VIDEO_EXTS.has(ext)) {
      return { kind: "video", src: videoSrcURL(type, sub, f.name) };
    }
    if (AUDIO_EXTS.has(ext)) {
      return { kind: "audio" };
    }
    return { kind: "icon", text: "📄" };
  }

  function renderGrid(opts?: { scrollTo?: number }): void {
    const q = state.query;
    // Wiping innerHTML resets the scroller, so the offset is captured here and
    // put back at the end. `scrollTo` overrides the capture for a caller that
    // already knows where the view belongs — a navigation's remembered offset,
    // or 0 for a new search or sort.
    const targetScrollTop = opts?.scrollTo ?? scroller.current();
    gridEl.innerHTML = "";
    // ONCE per render pass, not once per card: the kit's read is cheap but it
    // is still a walk of the setting store, and a per-card read would also let
    // the config change halfway down a grid.
    const svCfg = readSafeViewConfig();
    // The keyword 🙈 writes, read from the same snapshot for the same reason.
    // null (an empty keyword list) means no control on any card this pass.
    const safeKeyword = sensitiveKeyword(svCfg);

    // Flat view collapses the subtree into files only — no ".." card and no
    // folder cards (the backend returns dirs:[] recursively anyway). A ".."
    // here would silently drop out of flat view.
    const flat = isFlat();
    const pinnedView = isPinned();
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
      // A folder is matched by NAME ONLY — it carries no metadata to read. So a
      // blandly-named folder full of sensitive files is NOT caught here; it is
      // caught in flat view, which lists the files themselves. The README says
      // so rather than implying folder-level coverage.
      if (
        isSensitive({ name: d.name }, svCfg) &&
        !revealSet.has(state.type, state.subfolder, d.name)
      ) {
        applySafeView(c, svCfg, () => {
          revealSet.reveal(state.type, state.subfolder, d.name);
          renderGrid();
        });
      }
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
      // Both the flat and the pinned view mix locations within one grid, so the
      // match has to be against the CARD's own address (fileType + fileSub),
      // not the view's — state.type is "pinned" here and matches nothing.
      const selected =
        flat || pinnedView
          ? fileType(f) === initialSnapshot.type &&
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
      const missing = f.pinExists === false;
      if (missing) {
        c.classList.add("is-missing");
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
            : t.kind === "audio"
              ? // A GLYPH, not an <audio controls>. Every click inside a file
                // card that is not a star / 📌 / 🙈 / ⓘ / subpath commits the
                // file and closes the modal (see the grid click handler), so an
                // inline player would commit-and-close on the first tap at its
                // play button. Preview belongs on a control that is explicitly
                // not the select target; tracked as a follow-up to #88.
                `<div class="ip-thumb-icon is-audio">🎵</div>`
              : `<div class="ip-thumb-icon">${t.text}</div>`;
      // Whether a metadata WRITE can reach this card's file. /rating and /tag
      // are contained to input/output/temp — a `type: "path"` write is refused
      // at the resolver's first statement — so in path mode the stars and 🙈
      // would be controls whose every press is a 400. Reads are unaffected:
      // the thumbnail, the preview and ⓘ all still work there. Audio cards are
      // ordinary cards here: the gate is the card's TYPE, not its media kind,
      // so 🎵 in a path picker gets no star row for the same reason 🖼 doesn't.
      const writable = SANDBOXED_TYPES.includes(fileType(f));
      // No stars on a missing pin either: the rating write would address a
      // file that isn't there, and the optimistic repaint would make the
      // failure look like it had worked until the response came back.
      const stars =
        mode === "directory" || missing || !writable ? "" : starsHTML("ip", ratingOf(f));
      // 📌 pins the FILE. Sandboxed roots only — a path picker has no stable
      // type to pin against and the store rejects `type: "path"` — and never in
      // directory mode, where file cards are inert. Reads fileType(f) so a card
      // in the pinned view pins/unpins under its OWN root.
      const pinned = isFilePinned(f);
      const pinBtn =
        mode !== "directory" && SANDBOXED_TYPES.includes(fileType(f))
          ? `<button type="button" class="ip-pin-file${pinned ? " is-pinned" : ""}" aria-pressed="${pinned}" title="${pinned ? "Unpin this file" : "Pin this file"}">📌</button>`
          : "";
      // ⓘ opens the embedded generation metadata. Gated on the card being an
      // IMAGE, not on the tab: /metadata is a read and accepts type=path, so
      // it renders on a path picker too — the one control that isn't scoped to
      // sandboxed roots. Video cards get none (the endpoint is IMG_EXTS-gated).
      const infoBtn =
        mode !== "directory" && !missing && IMG_EXTS.has((f.ext || "").toLowerCase())
          ? `<button type="button" class="ip-info" title="Generation metadata">ⓘ</button>`
          : "";
      // 🙈 writes the user's first Safe View keyword into the file's
      // dc:subject. Offered only when there IS such a keyword (see
      // sensitiveKeyword), never on a missing pin — the write would address a
      // file that isn't there — and never in directory mode, where file cards
      // are inert.
      const markBtn =
        mode !== "directory" && !missing && writable && safeKeyword
          ? markSensitiveHTML("ip", safeKeyword, hasSensitiveTag(f, safeKeyword))
          : "";
      // Flat view: show the file's folder above the thumbnail. It's a button —
      // tapping it drops back to folder view at that directory. The LABEL is
      // the relative subpath (what the user reads) while data-sub is the joined
      // one (where the tap goes); they differ whenever flat view is entered
      // from a non-root subfolder, so a root-only test cannot see a mix-up.
      // Top-level files get a muted "/" so the row height stays consistent.
      // The pinned view reuses the same row, but shows the FULL address
      // (`output/2026-08-04/`) because pins span roots — a bare subpath there
      // would not say which root the file is in. Its target carries the pin's
      // own type alongside the subfolder.
      const subLabel = pinnedView
        ? (() => {
            const ft = fileType(f);
            const sub = fileSub(f);
            const label = sub ? `${ft}/${sub}` : `${ft}/`;
            return `<button type="button" class="ip-subpath" data-sub="${escHTML(sub)}" data-pin-type="${escHTML(ft)}" title="Go to ${escHTML(label)}">${escHTML(label)}</button>`;
          })()
        : flat
          ? f.subpath
            ? `<button type="button" class="ip-subpath" data-sub="${escHTML(fileSub(f))}" title="Go to ${escHTML(f.subpath)}">${escHTML(f.subpath)}</button>`
            : `<div class="ip-subpath is-root" title="Top level">/</div>`
          : "";
      c.innerHTML = `
                ${subLabel}
                <div class="ip-thumb">${thumbInner}${infoBtn}${pinBtn}${markBtn}</div>
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
      // LAST, so nothing above can re-populate a label after it was blocked
      // out — the highlight pass rebuilds `.ip-name`'s children, and spoilering
      // before it would leave the class on an element whose title had since
      // been restored.
      if (isHiddenCard(f, svCfg)) {
        applySafeView(c, svCfg, () => {
          revealSet.reveal(fileType(f), fileSub(f), f.name);
          renderGrid();
        });
      }
      gridEl.appendChild(c);
      visible++;
    }

    const empty = !visible && !state.dirs.length && !showUp;
    if (empty) {
      const el = document.createElement("div");
      el.className = "ip-empty";
      el.textContent =
        mode === "directory"
          ? "No subfolders here."
          : pinnedView
            ? "Nothing pinned yet — tap 📌 on a card to pin it."
            : "No matching files in this directory.";
      gridEl.appendChild(el);
    }

    if (useFolderEl) {
      useFolderEl.textContent =
        state.type === "path"
          ? `Use ${shortenPath(state.absPath)}`
          : `Use ${state.type}${state.subfolder ? `/${state.subfolder}` : ""}`;
    }

    setCount(visible, state.files.length);

    // On the FIRST paint of a modal, centring the currently loaded image beats
    // any remembered offset: the user opened the picker to change this widget's
    // image, and seeing its neighbours above and below is the whole point. Only
    // once per open, and only where a remembered offset is not already the
    // better answer — coming BACK to a folder you scrolled resumes there.
    let target = targetScrollTop;
    if (!state.didInitialScroll) {
      state.didInitialScroll = true;
      if (target <= 0) target = selectedCentreOffset() ?? target;
    }

    // Restore BEFORE installing the observer, so its first pass is computed
    // against the final viewport. Observing first queues the top-of-list band,
    // which in flat view is thousands of wrong /thumb requests.
    //
    // This ordering is LATENT rather than load-bearing today, and the mutation
    // table says so by not carrying it: IntersectionObserver delivers its
    // callbacks asynchronously, after the task holding the synchronous first
    // write, so swapping these two lines was caught on one browser-suite run
    // and missed on the next. It matters for the frames the re-assert loop
    // corrects across — which is exactly when it would be hardest to debug.
    //
    // This is also what makes the centring above safe in FLAT view, where it
    // used to be skipped: the target can be thousands of cards down a grid
    // whose thumbnails are still placeholders, so a single bare write gets
    // CLAMPED against a shorter-than-final layout. The kit's restore re-asserts
    // across the next few frames instead, against the bound in force at each.
    // (Card height does not actually depend on the thumbnail — `.ip-thumb` is
    // `aspect-ratio: 1/1` inside a fixed grid track — so the clamp only bites
    // while cards are still being appended. Measured in tests/e2e rather than
    // assumed: `flat-view centring lands on the selected card`.)
    scroller.restore(target);
    installLazyThumbs(gridEl);
  }

  /**
   * Where the scroller must sit to put the selected card in the middle of the
   * viewport, or null when nothing is selected in this listing.
   */
  function selectedCentreOffset(): number | null {
    const card = gridEl.querySelector(".ip-card.is-selected") as HTMLElement | null;
    if (!card) return null;
    const body = modal.bodyEl;
    return Math.max(0, card.offsetTop - Math.max(0, (body.clientHeight - card.offsetHeight) / 2));
  }

  function shortenPath(p: string): string {
    if (!p) return "/";
    if (p.length <= 48) return p;
    return `…${p.slice(-46)}`;
  }

  // The root MUST be the shell body: `.ip-grid` has no overflow clip, so
  // rooting on it makes every card intersect on the first callback and the
  // "lazy" load fires for the whole listing at once. The kit takes the root as
  // a required parameter for exactly this reason.
  let disposeLazyThumbs: (() => void) | null = null;

  function installLazyThumbs(rootEl: HTMLElement): void {
    disposeLazyThumbs?.();
    disposeLazyThumbs = installLazyMedia(rootEl, { root: modal.bodyEl, rootMargin: "300px" });
  }

  // Takes the file object so flat view commits the file's OWN folder. The
  // value contract is unchanged: buildLoadImageValue already normalises a
  // nested subfolder, so a flat pick of a/b/x.png yields exactly what folder
  // navigation would have produced.
  function commitFile(f: ListingFile): void {
    let value: string;
    // fileType(f), not state.type: on the pinned tab the view's "location" is
    // the pinned list, while the file's own root is what the value must name.
    // A pinned output/2026-08-04/a.png commits "2026-08-04/a.png [output]" with
    // no navigation to its folder at all — the point of the whole feature.
    const type = fileType(f);
    if (type === "path") {
      value = joinAbs(state.absPath, f.name);
    } else {
      value = buildLoadImageValue(type, fileSub(f), f.name);
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
    if (state.type === "path") {
      applyValue(state.absPath || "/");
      modal.close();
      return;
    }
    // A sandboxed folder rides the same annotated grammar as a file, with the
    // whole relative path in the name slot. At a root the relative path is
    // "." rather than "": get_annotated_filepath joins it onto the base dir
    // and abspath normalises it away, whereas "" would serialize as a blank
    // widget value that reads as "nothing chosen".
    const value = buildLoadImageValue(state.type, "", state.subfolder || ".");
    const values = widget.options?.values;
    if (Array.isArray(values) && !values.includes(value)) {
      values.push(value);
    }
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
/* Safe View's per-card reveal, repositioned for THIS pack's card layout: the
   kit parks it top-left, which is exactly where .ip-pin-file sits, and
   top-right is .ip-info. Bottom-left of the thumbnail is the one free corner.
   Plain values only — no min()/calc() — because jsdom drops those and the
   tests assert this through getComputedStyle. */
.ip-card .cmk-sv-reveal {
    top: auto;
    bottom: 4px;
    left: 4px;
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
/* 📌 file-pin toggle, mirroring ⓘ in the thumbnail's other corner. */
.ip-pin-file {
    position: absolute; top: 4px; left: 4px;
    min-width: 30px; min-height: 30px; padding: 0;
    background: rgba(20, 20, 26, 0.78); color: #6a6a76;
    border: 1px solid #33333f; border-radius: 4px;
    font-size: 13px; line-height: 1; cursor: pointer; font-family: inherit;
    filter: grayscale(1); opacity: 0.75;
}
.ip-pin-file:hover { background: #2f3a52; filter: none; opacity: 1; }
.ip-pin-file.is-pinned {
    background: #3a3320; border-color: #78683a; filter: none; opacity: 1;
}
/* 🙈 mark-sensitive toggle. Bottom-RIGHT: ⓘ has top-right, 📌 top-left, and
   Safe View's reveal button bottom-left (above), so this is the last free
   corner. It must stay OUT of .cmk-sv-blur's subtree — it sits on .ip-thumb,
   which is not the blurred element — or marking a file would blur the control
   that unmarks it. */
.ip-mark-sensitive {
    position: absolute; bottom: 4px; right: 4px;
    min-width: 30px; min-height: 30px; padding: 0;
    background: rgba(20, 20, 26, 0.78); color: #6a6a76;
    border: 1px solid #33333f; border-radius: 4px;
    font-size: 13px; line-height: 1; cursor: pointer; font-family: inherit;
    filter: grayscale(1); opacity: 0.75;
}
.ip-mark-sensitive:hover { background: #2f3a52; filter: none; opacity: 1; }
.ip-mark-sensitive.is-marked {
    background: #3a2028; border-color: #7a4a58; filter: none; opacity: 1;
}
.ip-mark-sensitive:disabled { cursor: progress; opacity: 0.5; }
/* A pin whose file no longer resolves: dimmed, and inert to a commit — the tap
   handler refuses it and points at 📌 / "Prune missing" instead. Asserted
   through getComputedStyle in tests/js/pins.test.js, so it must stay a class
   rule with no min()/calc() (jsdom drops those values). */
.ip-card.is-missing {
    opacity: 0.45;
    cursor: default;
    border-style: dashed;
}
.ip-card.is-missing:hover { border-color: #2a2a32; transform: none; }
.ip-pin-chip.is-missing .ip-pin-go { opacity: 0.5; text-decoration: line-through; }
.ip-prune {
    color: #c8a95c;
    border-color: #5a4a2a;
}
.ip-prune:hover { background: #3a3320; color: #ffd866; }

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

// ============================================================
// Extension registration
// ============================================================

// The three hooks each see the same node classes, so they share one entry
// point. Each enhancer is idempotent (its own `_…Enhanced` flag) and matches a
// disjoint set of nodes, so the order is not load-bearing.
function enhanceNode(node: PickerNode): void {
  enhanceUploadComboNode(node);
  enhanceVHSComboNode(node);
  enhanceVHSPathNode(node);
}

try {
  app.registerExtension({
    name: "comfy.gallery-loader.image-picker",
    // Safe View's settings come from the kit rather than being hand-written
    // here, and comfyui-image-browser spreads the SAME array with the SAME ids
    // on purpose. ComfyUI's addSetting skips a duplicate id with a
    // console.warn and returns, so two installed packs yield one dialog row,
    // one stored value, and cross-pack (and cross-device, via the server-side
    // settings file) agreement for free. The benign warning from whichever
    // pack loses the import race is expected — do not try to suppress it or to
    // register conditionally, which would make WHICH pack defines the setting
    // depend on a race with no stable winner.
    //
    // The cast is the same one the kit documents: it deliberately does not
    // depend on @comfyorg/comfyui-frontend-types, so its structural setting
    // type needs widening at the registration boundary.
    settings: safeViewSettings() as unknown as Parameters<
      typeof app.registerExtension
    >[0]["settings"],
    async beforeRegisterNodeDef(_nodeType, nodeData) {
      try {
        defangNodeData(nodeData as unknown as NodeData);
      } catch (e) {
        console.warn(`[${EXT_NAME}] defang failed for ${(nodeData as NodeData)?.name}`, e);
      }
    },
    setup() {
      ensureStyleOnce(STYLE_ID, PICKER_CSS);
      // In setup(), never at module scope: registration at import time would
      // put a DISABLED pack's row in the Touch Tools chooser. Idempotent by id,
      // so the sibling gallery pack also calling it is harmless — and having
      // the KIT build the row is what stops two rows appearing with drifting
      // labels when both packs are installed.
      registerSafeViewHubToggle();
      debug("image-picker setup running");
      const nodes = (app?.graph as { _nodes?: unknown[] } | undefined)?._nodes;
      if (Array.isArray(nodes)) {
        for (const n of nodes) enhanceNode(n as PickerNode);
      }
    },
    nodeCreated(node) {
      enhanceNode(node as unknown as PickerNode);
    },
    loadedGraphNode(node) {
      enhanceNode(node as unknown as PickerNode);
    },
  });
} catch (e) {
  console.error(`[${EXT_NAME}] image-picker.js: registerExtension threw`, e);
}
