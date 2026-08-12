// comfyui-gallery-loader — frontend extension
//
// Replaces the string `image` widget on GalleryLoadImage with a touch-
// friendly card-grid picker. Reads/writes a single string of the form
//
//   <subfolder>/<filename> [input|output|temp]    (annotated, default)
//   <absolute>/<filename>                          (when type=path)
//
// Backend node + listing endpoints live in gallery_loader.py.

import {
  applyStars,
  escapeHTML,
  fuzzyScore,
  installLazyMedia,
  isSafeViewActive,
  isSensitive,
  isValidSort,
  makeRevealButton,
  makeRevealSet,
  nextRating,
  notify,
  onSafeViewChange,
  postRating,
  type RatingAddress,
  ratingOf,
  readSafeViewConfig,
  SAFE_VIEW_GLYPH_OFF,
  SAFE_VIEW_GLYPH_ON,
  type SafeViewConfig,
  SORT_OPTIONS,
  setBlurred,
  setSpoilered,
  sortFiles,
  starsHTML,
  toggleSafeView,
  warnRating,
} from "@laurigates/comfy-modal-kit";
import { app } from "/scripts/app.js";

const EXT_NAME = "comfyui-gallery-loader";
const NODE = "GalleryLoadImage";
const LIST_URL = "/gallery_loader/list";
const RATING_URL = "/gallery_loader/rating";
const CSS_URL = "/extensions/comfyui-gallery-loader/css/gallery_loader.css";

// Inject styles once.
if (!document.querySelector(`link[href="${CSS_URL}"]`)) {
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = CSS_URL;
  document.head.appendChild(link);
}

const TYPES = ["input", "output", "temp", "path"] as const;

// Some sensible mins. The grid is internally scrollable, so the user can
// keep the node compact and still see thumbnails.
// Persisted sort preference. Deliberately the SAME key the modal picker uses —
// one choice across every surface. The option lists had to be converged first:
// this grid offered size:asc / pixels:asc that the picker's validator rejected,
// so a preference set here was silently dropped there with nothing to explain
// it to the user.
const SORT_STORAGE_KEY = "comfyui-gallery-loader:sort";

function loadSavedSort(): { key: string; dir: string } | null {
  try {
    const raw = localStorage.getItem(SORT_STORAGE_KEY);
    if (!raw || !isValidSort(raw)) return null;
    const [key, dir] = raw.split(":");
    return key && dir ? { key, dir } : null;
  } catch {
    return null;
  }
}

function saveSort(key: string, dir: string): void {
  try {
    localStorage.setItem(SORT_STORAGE_KEY, `${key}:${dir}`);
  } catch {
    // Private mode / disabled storage — non-fatal.
  }
}

const MIN_NODE_W = 360;
const MIN_NODE_H = 460;

// ============================================================
// Types
// ============================================================
//
// The package's `ComfyApp` type is the only widget/graph type it exports at
// the module root — `LGraphNode`, `LGraphCanvas`, and the widget interfaces
// are declared internally but not re-exported, so they cannot be imported.
// We model the small surface this pack touches with local structural
// interfaces instead (narrower blast radius). `ComfyApp` types the imported
// `app` via the shim in `comfyui-shims.d.ts`.

interface GalleryWidget {
  name: string;
  value: unknown;
  type?: string;
  hidden?: boolean;
  options?: { hidden?: boolean; values?: unknown } & Record<string, unknown>;
  computeSize?: (...args: unknown[]) => [number, number];
  element?: { style?: CSSStyleDeclaration };
  inputEl?: { style?: CSSStyleDeclaration };
}

interface GalleryNode {
  widgets?: GalleryWidget[];
  size: [number, number];
  addDOMWidget: (
    name: string,
    type: string,
    element: HTMLElement,
    options: Record<string, unknown>,
  ) => unknown;
  setDirtyCanvas?: (fg: boolean, bg: boolean) => void;
}

// A node-definition prototype as exposed by `beforeRegisterNodeDef`. Only the
// lifecycle hook this pack wraps is modelled.
interface NodeTypeProto {
  prototype: {
    onNodeCreated?: (...args: unknown[]) => unknown;
  };
}

interface NodeData {
  name: string;
}

interface ListingDir {
  name: string;
}

interface ListingFile {
  name: string;
  mtime: number;
  size?: number;
  width?: number;
  height?: number;
  rating?: number;
}

interface ParsedValue {
  type: string;
  subfolder: string;
  name: string;
  isAbs: boolean;
}

app.registerExtension({
  name: "comfy.gallery-loader",
  async beforeRegisterNodeDef(nodeType, nodeData) {
    const data = nodeData as unknown as NodeData;
    if (data.name !== NODE) return;
    const proto = (nodeType as unknown as NodeTypeProto).prototype;
    const orig = proto.onNodeCreated;
    proto.onNodeCreated = function (this: GalleryNode, ...args: unknown[]) {
      const r = orig?.apply(this, args);
      try {
        attachGallery(this);
      } catch (e) {
        console.error("[gallery_loader] attach failed:", e);
      }
      return r;
    };
  },
});

function parseAnnotated(value: unknown): ParsedValue {
  // Returns { type, subfolder, name, isAbs } for a stored widget value.
  const v = (typeof value === "string" ? value : "").trim();
  if (!v) return { type: "input", subfolder: "", name: "", isAbs: false };
  const m = v.match(/^(.*?)\s*\[(input|output|temp)\]\s*$/);
  if (m) {
    const rel = (m[1] as string).replace(/\\/g, "/");
    const idx = rel.lastIndexOf("/");
    return {
      type: m[2] as string,
      subfolder: idx >= 0 ? rel.slice(0, idx) : "",
      name: idx >= 0 ? rel.slice(idx + 1) : rel,
      isAbs: false,
    };
  }
  if (v.startsWith("/") || /^[A-Za-z]:[\\/]/.test(v)) {
    const norm = v.replace(/\\/g, "/");
    const idx = norm.lastIndexOf("/");
    return {
      type: "path",
      subfolder: idx >= 0 ? norm.slice(0, idx) : "",
      name: idx >= 0 ? norm.slice(idx + 1) : norm,
      isAbs: true,
    };
  }
  // Bare relative — assume input.
  const idx = v.lastIndexOf("/");
  return {
    type: "input",
    subfolder: idx >= 0 ? v.slice(0, idx) : "",
    name: idx >= 0 ? v.slice(idx + 1) : v,
    isAbs: false,
  };
}

function buildAnnotated(type: string, subfolder: string, name: string): string {
  if (type === "path") {
    if (subfolder) return `${subfolder.replace(/\/$/, "")}/${name}`;
    return name;
  }
  const sub = (subfolder || "").replace(/^\/+|\/+$/g, "");
  const rel = sub ? `${sub}/${name}` : name;
  return `${rel} [${type}]`;
}

// All thumbnails go through the pack's /thumb endpoint (never core /api/view,
// which re-encodes on every request with no cache headers). ?v= (mtime+size
// from /list) pairs with the backend's long max-age: a changed file keys a
// new URL, an unchanged one never re-fetches.
function thumbURL(type: string, subfolder: string, f: ListingFile, absDir: string): string {
  const v = `${f.mtime}-${f.size ?? 0}`;
  if (type === "path") {
    const full = `${(absDir || "").replace(/\/$/, "")}/${f.name}`;
    return `/gallery_loader/thumb?path=${encodeURIComponent(full)}&v=${encodeURIComponent(v)}`;
  }
  const params = new URLSearchParams({
    type,
    subfolder: subfolder || "",
    name: f.name,
    v,
  });
  return `/gallery_loader/thumb?${params.toString()}`;
}

interface GalleryState {
  type: string;
  subfolder: string;
  absDir: string;
  search: string;
  sortKey: string;
  sortDir: string;
  dirs: ListingDir[];
  files: ListingFile[];
  selectedName: string;
}

// Exported as a test seam only — production reaches it through onNodeCreated
// below. Mirrors image-picker.ts's openImagePicker, which exists for the same
// reason: this module is otherwise pure side-effect registration with nothing
// importable, and that is what left the inline grid with no JS coverage.
export function attachGallery(node: GalleryNode): void {
  const found = node.widgets?.find((w) => w.name === "image");
  if (!found) return;
  // Bind a non-undefined alias so the nested render closures below see the
  // narrowed type (TS does not always carry `find()`-undefined narrowing into
  // every closure body).
  const widget: GalleryWidget = found;

  // Hide the string widget but keep it serializable so the backend
  // still receives the path. The canonical "hide" toggle pair the
  // frontend reads is widget.hidden + widget.options.hidden; the
  // collapsed computeSize is belt-and-braces against older widget
  // layouts. The DOM input elements also get display:none for the
  // versions of the frontend that position them by canvas coords
  // regardless of `hidden`.
  widget.hidden = true;
  widget.options = widget.options || {};
  widget.options.hidden = true;
  widget.computeSize = () => [0, -4];
  for (const key of ["element", "inputEl"] as const) {
    const el = widget[key];
    if (el?.style) el.style.display = "none";
  }

  const root = document.createElement("div");
  root.className = "gl-root";
  root.innerHTML = `
        <div class="gl-bar">
            <div class="gl-chips"></div>
            <select class="gl-sort" title="Sort">
                <!-- options injected from the kit's SORT_OPTIONS below -->
            </select>
            <button class="gl-icon gl-safe-view"></button>
            <button class="gl-icon gl-refresh" title="Refresh">⟳</button>
        </div>
        <div class="gl-crumbs"></div>
        <input class="gl-pathinput" type="text" spellcheck="false"
               placeholder="/absolute/path/to/dir or paste annotated value">
        <input class="gl-search" type="search" placeholder="Filter…">
        <div class="gl-grid" tabindex="0"></div>
        <div class="gl-foot">
            <div class="gl-status"></div>
            <div class="gl-selected" title="Current selection"></div>
        </div>
    `;

  // Build chips.
  const chipsEl = root.querySelector(".gl-chips") as HTMLElement;
  for (const t of TYPES) {
    const b = document.createElement("button");
    b.className = "gl-chip";
    b.dataset.type = t;
    b.textContent = t;
    chipsEl.appendChild(b);
  }

  const initial = parseAnnotated(widget.value);

  const state: GalleryState = {
    type: initial.type,
    subfolder: initial.subfolder,
    absDir: initial.isAbs ? initial.subfolder : "",
    search: "",
    sortKey: "mtime",
    sortDir: "desc",
    // Cache last listing so re-renders without re-fetch.
    dirs: [],
    files: [],
    selectedName: initial.name,
  };

  // Restore the user's last-used sort so it persists across node creations,
  // and matches whatever they picked in the modal picker.
  const savedSort = loadSavedSort();
  if (savedSort) {
    state.sortKey = savedSort.key;
    state.sortDir = savedSort.dir;
  }

  const refs = {
    grid: root.querySelector(".gl-grid") as HTMLElement,
    status: root.querySelector(".gl-status") as HTMLElement,
    crumbs: root.querySelector(".gl-crumbs") as HTMLElement,
    chips: chipsEl,
    search: root.querySelector(".gl-search") as HTMLInputElement,
    path: root.querySelector(".gl-pathinput") as HTMLInputElement,
    selected: root.querySelector(".gl-selected") as HTMLElement,
    refresh: root.querySelector(".gl-refresh") as HTMLElement,
    sort: root.querySelector(".gl-sort") as HTMLSelectElement,
    safeView: root.querySelector(".gl-safe-view") as HTMLButtonElement,
  };

  // ---- Safe View ---------------------------------------------------------
  //
  // DISCRETION, NOT ACCESS CONTROL: the blur is a CSS class and the blurred
  // bytes are still fetched. Same filter, same shared settings and the same
  // per-session reveal semantics as the modal picker — the two surfaces render
  // the same files and must agree about which of them are hidden.
  const revealSet = makeRevealSet();

  /**
   * The LOGICAL folder address, matching what the backend builds and what the
   * modal picker sends: `output/nsfw/2026-08-04` for a sandboxed root, the
   * absolute directory for type=path. The root segment is included, so a
   * keyword of `output` matches.
   */
  function safeViewPath(): string {
    if (state.type === "path") return state.absDir || "";
    return state.subfolder ? `${state.type}/${state.subfolder}` : state.type;
  }

  function renderSafeViewToggle(): void {
    const on = isSafeViewActive();
    refs.safeView.textContent = on ? SAFE_VIEW_GLYPH_ON : SAFE_VIEW_GLYPH_OFF;
    refs.safeView.classList.toggle("is-active", on);
    refs.safeView.title = on
      ? "Safe View on — matching thumbnails are blurred. Tap to show everything."
      : "Safe View off — tap to blur thumbnails matching your keywords.";
    refs.safeView.setAttribute("aria-pressed", String(on));
  }

  refs.safeView.addEventListener("click", () => {
    // Writes through the setting store, which fires onChange → the
    // subscription below. No repaint here on purpose.
    toggleSafeView();
  });

  /**
   * The keyword string to send for server-side hiding, or "" when hiding is
   * off. Doubles as the listing signature: a change means the server would
   * return a different SET of rows, so a repaint is not enough.
   */
  function safeHideKeywords(): string {
    const cfg = readSafeViewConfig();
    return cfg.hide && isSafeViewActive(cfg) ? cfg.keywords.join(",") : "";
  }

  let lastSafeHideKeywords = safeHideKeywords();

  // This grid lives on a node, which can be deleted without any teardown hook
  // reaching us — so the listener retires itself once its root leaves the
  // document rather than repainting a detached grid forever. Checking
  // isConnected is cheap and needs no lifecycle plumbing the pack does not
  // already have.
  const disposeSafeViewSub = onSafeViewChange(() => {
    if (!root.isConnected) {
      disposeSafeViewSub();
      return;
    }
    renderSafeViewToggle();
    const kw = safeHideKeywords();
    if (kw !== lastSafeHideKeywords) {
      void loadAndRender();
      return;
    }
    renderGrid();
  });

  /** Paint one card as hidden. See the picker for why the media, not the thumb. */
  function applySafeView(card: HTMLElement, cfg: SafeViewConfig, onReveal: () => void): void {
    card.classList.add("is-safe-hidden");
    // The thumbnail of a FOLDER card is the generic 📁 glyph, which says
    // nothing about what is hidden — there is no media to blur there, and the
    // name (spoilered below) is the sensitive part.
    const media = card.querySelector(".gl-thumb img");
    if (media) setBlurred(media, true);
    if (cfg.blurNames) {
      // Also removes the title attribute — a native tooltip would otherwise
      // render the full name on hover, whatever the CSS says.
      for (const el of card.querySelectorAll(".gl-name")) setSpoilered(el, true);
    }
    const host = card.querySelector(".gl-thumb") ?? card;
    host.appendChild(makeRevealButton({ onReveal }));
  }
  // Options come from the kit so both surfaces offer — and accept — the same
  // ten, which is what makes sharing the :sort key safe.
  refs.sort.innerHTML = SORT_OPTIONS.map(
    (o) => `<option value="${o.value}">${escapeHTML(o.label)}</option>`,
  ).join("");
  refs.sort.value = `${state.sortKey}:${state.sortDir}`;
  refs.sort.addEventListener("change", (e) => {
    const [key, dir] = (e.target as HTMLSelectElement).value.split(":");
    state.sortKey = key as string;
    state.sortDir = dir as string;
    saveSort(key as string, dir as string);
    renderGrid();
  });

  // Wire up handlers.
  chipsEl.addEventListener("click", (e) => {
    const t = (e.target as HTMLElement).closest(".gl-chip") as HTMLElement | null;
    if (!t) return;
    state.type = t.dataset.type as string;
    if (state.type !== "path") state.subfolder = "";
    renderControls();
    loadAndRender();
  });

  refs.refresh.addEventListener("click", () => loadAndRender());

  refs.search.addEventListener("input", (e) => {
    state.search = (e.target as HTMLInputElement).value.toLowerCase();
    renderGrid();
  });

  // Path field commits on Enter (for type=path) or blur.
  const commitPath = () => {
    const v = refs.path.value.trim();
    if (state.type === "path") {
      state.absDir = v;
      loadAndRender();
    }
  };
  refs.path.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      commitPath();
    }
  });
  refs.path.addEventListener("blur", commitPath);

  // Crumbs click = navigate up.
  refs.crumbs.addEventListener("click", (e) => {
    const seg = (e.target as HTMLElement).closest("[data-crumb]") as HTMLElement | null;
    if (!seg) return;
    if (state.type === "path") {
      state.absDir = seg.dataset.crumb || "/";
    } else {
      state.subfolder = seg.dataset.crumb || "";
    }
    loadAndRender();
  });

  // Grid clicks: star rates, dir descends, file selects, ".." goes up.
  refs.grid.addEventListener("click", (e) => {
    const star = (e.target as HTMLElement).closest(".gl-star") as HTMLElement | null;
    if (star) {
      const card = star.closest(".gl-card") as HTMLElement | null;
      const row = star.parentElement as HTMLElement | null;
      if (card && row) {
        const cur = Number(row.dataset.rating || "0");
        setStarRating(card.dataset.name as string, row, nextRating(cur, Number(star.dataset.val)));
      }
      return;
    }
    const card = (e.target as HTMLElement).closest(".gl-card") as HTMLElement | null;
    if (!card) return;
    if (card.classList.contains("is-up")) {
      if (state.type === "path") {
        const p = (state.absDir || "/").replace(/\/+$/, "");
        const slash = p.lastIndexOf("/");
        state.absDir = slash <= 0 ? "/" : p.slice(0, slash);
      } else {
        const p = (state.subfolder || "").replace(/\/+$/, "");
        const slash = p.lastIndexOf("/");
        state.subfolder = slash <= 0 ? "" : p.slice(0, slash);
      }
      loadAndRender();
      return;
    }
    if (card.classList.contains("is-dir")) {
      const name = card.dataset.name as string;
      if (state.type === "path") {
        const base = (state.absDir || "").replace(/\/+$/, "");
        state.absDir = `${base}/${name}`;
      } else {
        const base = (state.subfolder || "").replace(/\/+$/, "");
        state.subfolder = base ? `${base}/${name}` : name;
      }
      loadAndRender();
      return;
    }
    if (card.classList.contains("is-file")) {
      state.selectedName = card.dataset.name as string;
      commitSelection();
      renderGrid();
    }
  });

  // Block LiteGraph from intercepting input on the DOM widget.
  const stop = (e: Event) => e.stopPropagation();
  for (const ev of [
    "pointerdown",
    "pointermove",
    "pointerup",
    "click",
    "dblclick",
    "contextmenu",
    "touchstart",
    "touchmove",
    "touchend",
    "keydown",
    "keyup",
  ]) {
    root.addEventListener(ev, stop, { capture: false });
  }
  // Wheel scrolls the grid, not the canvas.
  refs.grid.addEventListener(
    "wheel",
    (e) => {
      refs.grid.scrollTop += e.deltaY;
      e.preventDefault();
      e.stopPropagation();
    },
    { passive: false },
  );

  // Mount on the node.
  node.addDOMWidget("gl_gallery", "gallery", root, {
    serialize: false,
    // Hide the gallery DOM when the canvas is zoomed out past
    // LiteGraph's readability threshold. The grid is the most
    // expensive DOM widget in the pack — at low zoom it can't be
    // used anyway, so dropping it avoids paying the per-frame
    // overlay-resync cost while the user pans a large workflow.
    hideOnZoom: true,
    getMinHeight: () => 360,
  });

  if (node.size[0] < MIN_NODE_W) node.size[0] = MIN_NODE_W;
  if (node.size[1] < MIN_NODE_H) node.size[1] = MIN_NODE_H;

  // ---- rendering ---------------------------------------------------------

  function renderControls(): void {
    // Active chip
    for (const c of chipsEl.querySelectorAll(".gl-chip")) {
      c.classList.toggle("is-active", (c as HTMLElement).dataset.type === state.type);
    }
    // Path input visible only for type=path
    refs.path.style.display = state.type === "path" ? "" : "none";
    if (state.type === "path") refs.path.value = state.absDir || "";

    // Crumbs
    refs.crumbs.innerHTML = "";
    if (state.type === "path") {
      const parts = (state.absDir || "/").split("/").filter(Boolean);
      const rootBtn = document.createElement("button");
      rootBtn.dataset.crumb = "/";
      rootBtn.className = "gl-crumb";
      rootBtn.textContent = "/";
      refs.crumbs.appendChild(rootBtn);
      let cur = "";
      for (const seg of parts) {
        cur += `/${seg}`;
        const b = document.createElement("button");
        b.dataset.crumb = cur;
        b.className = "gl-crumb";
        b.textContent = seg;
        refs.crumbs.appendChild(b);
      }
    } else {
      const r = document.createElement("button");
      r.dataset.crumb = "";
      r.className = "gl-crumb";
      r.textContent = state.type;
      refs.crumbs.appendChild(r);
      const parts = (state.subfolder || "").split("/").filter(Boolean);
      let cur = "";
      for (const seg of parts) {
        cur = cur ? `${cur}/${seg}` : seg;
        const b = document.createElement("button");
        b.dataset.crumb = cur;
        b.className = "gl-crumb";
        b.textContent = seg;
        refs.crumbs.appendChild(b);
      }
    }
  }

  // The location the reveal set belongs to. Reveals survive a plain refresh
  // and a re-render, but a folder or source change is a deliberate change of
  // context and resets them.
  let revealLocation: string | null = null;

  function locationKey(): string {
    return state.type === "path" ? `path:${state.absDir}` : `${state.type}:${state.subfolder}`;
  }

  async function loadAndRender(): Promise<void> {
    lastSafeHideKeywords = safeHideKeywords();
    const here = locationKey();
    if (revealLocation !== null && revealLocation !== here) revealSet.clear();
    revealLocation = here;
    renderControls();
    refs.status.textContent = "Loading…";
    refs.grid.classList.add("is-loading");
    try {
      const params = new URLSearchParams({ type: state.type });
      if (state.type === "path") {
        if (!state.absDir) {
          refs.status.textContent = "Type an absolute path and press Enter.";
          refs.grid.innerHTML = "";
          refs.grid.classList.remove("is-loading");
          return;
        }
        params.set("path", state.absDir);
      } else {
        params.set("subfolder", state.subfolder || "");
      }
      // Sent ONLY when the user asked for hiding and there is something to
      // match with, so the default request URL is unchanged from before.
      const kw = safeHideKeywords();
      if (kw) {
        params.set("safe_kw", kw);
        params.set("safe_hide", "1");
      }
      const res = await fetch(`${LIST_URL}?${params.toString()}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || "list failed");
      state.dirs = data.dirs || [];
      state.files = data.files || [];
      refs.status.textContent = data.exists
        ? `${state.dirs.length} dir, ${state.files.length} img`
        : "Directory not found.";
    } catch (e) {
      console.error("[gallery_loader] list failed:", e);
      refs.status.textContent = `Error: ${(e as Error).message}`;
      state.dirs = [];
      state.files = [];
    }
    refs.grid.classList.remove("is-loading");
    renderGrid();
  }

  function renderGrid(): void {
    const grid = refs.grid;
    grid.innerHTML = "";
    // ONCE per render pass, not once per card.
    const svCfg = readSafeViewConfig();
    const svPath = safeViewPath();
    renderSafeViewToggle();

    const inSub = state.type === "path" ? state.absDir && state.absDir !== "/" : !!state.subfolder;

    if (inSub) {
      const up = document.createElement("div");
      up.className = "gl-card is-up";
      up.innerHTML = `<div class="gl-thumb gl-folder">↑</div><div class="gl-name">..</div>`;
      grid.appendChild(up);
    }

    const q = state.search;
    for (const d of state.dirs) {
      if (q && !d.name.toLowerCase().includes(q)) continue;
      const c = document.createElement("div");
      c.className = "gl-card is-dir";
      c.dataset.name = d.name;
      c.innerHTML = `<div class="gl-thumb gl-folder">📁</div><div class="gl-name" title="${escapeHTML(d.name)}">${escapeHTML(d.name)}</div>`;
      // A folder is matched by NAME ONLY — it carries no metadata to read, so a
      // blandly-named folder full of sensitive files is not caught here.
      if (
        isSensitive({ name: d.name }, svCfg) &&
        !revealSet.has(state.type, state.subfolder, d.name)
      ) {
        applySafeView(c, svCfg, () => {
          revealSet.reveal(state.type, state.subfolder, d.name);
          renderGrid();
        });
      }
      grid.appendChild(c);
    }

    // Fuzzy-rank while filtering (score order wins over the sort selection),
    // matching the modal picker. A plain substring test made "clp" miss
    // clip.mp4 here while finding it there.
    let sortedFiles: ListingFile[];
    if (q) {
      const scored: { f: ListingFile; score: number }[] = [];
      for (const f of state.files) {
        const r = fuzzyScore(q, f.name);
        if (r) scored.push({ f, score: r.score });
      }
      scored.sort((a, b) => b.score - a.score);
      sortedFiles = scored.map((x) => x.f);
    } else {
      sortedFiles = sortFiles(state.files, state.sortKey, state.sortDir);
    }
    for (const f of sortedFiles) {
      const c = document.createElement("div");
      c.className = "gl-card is-file";
      c.dataset.name = f.name;
      if (f.name === state.selectedName && currentSelectionDirMatches()) {
        c.classList.add("is-selected");
      }
      const url = thumbURL(state.type, state.subfolder, f, state.absDir);
      const stamp = new Date(f.mtime * 1000).toLocaleString();
      const dims = f.width && f.height ? `${f.width}×${f.height}` : "";
      const titleText = dims ? `${f.name}\n${dims}\n${stamp}` : `${f.name}\n${stamp}`;
      c.innerHTML = `
                <div class="gl-thumb"><img loading="lazy" decoding="async" data-src="${url}" alt=""></div>
                <div class="gl-name" title="${escapeHTML(titleText)}">${escapeHTML(f.name)}</div>
                ${dims ? `<div class="gl-dims">${dims}</div>` : ""}
                ${starsHTML("gl", ratingOf(f))}
            `;
      if (
        isSensitive({ name: f.name, path: svPath }, svCfg) &&
        !revealSet.has(state.type, state.subfolder, f.name)
      ) {
        applySafeView(c, svCfg, () => {
          revealSet.reveal(state.type, state.subfolder, f.name);
          renderGrid();
        });
      }
      grid.appendChild(c);
    }

    installLazyThumbs(grid);
    updateSelectedFooter();
  }

  function currentSelectionDirMatches(): boolean {
    const sel = parseAnnotated(widget.value);
    if (sel.type !== state.type) return false;
    if (state.type === "path") {
      return (sel.subfolder || "").replace(/\/+$/, "") === (state.absDir || "").replace(/\/+$/, "");
    }
    return (sel.subfolder || "") === (state.subfolder || "");
  }

  function commitSelection(): void {
    const value =
      state.type === "path"
        ? buildAnnotated("path", state.absDir, state.selectedName)
        : buildAnnotated(state.type, state.subfolder, state.selectedName);
    widget.value = value;
    // Trigger LiteGraph dirty + serialization.
    node.setDirtyCanvas?.(true, true);
    updateSelectedFooter();
  }

  function updateSelectedFooter(): void {
    refs.selected.textContent = (typeof widget.value === "string" ? widget.value : "") || "(none)";
  }

  function setStarRating(name: string, row: HTMLElement, next: number): void {
    const prev = Number(row.dataset.rating || "0");
    applyStars(row, next);
    const f = state.files.find((x) => x.name === name);
    if (f) f.rating = next;
    const addr: RatingAddress = {
      type: state.type,
      subfolder: state.subfolder,
      absDir: state.absDir,
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

  // Use IntersectionObserver to defer thumbnail loading until visible.
  // Cheap and self-contained per re-render.
  // `root: grid` is correct HERE and only here: `.gl-grid` has
  // overflow-y:auto, so it IS the scroller. The modal picker's `.ip-grid` has
  // no overflow clip and roots on the shell body instead. The kit takes the
  // root as a required parameter so neither call site can drift into the
  // other's answer.
  let disposeLazyThumbs: (() => void) | null = null;

  function installLazyThumbs(grid: HTMLElement): void {
    disposeLazyThumbs?.();
    disposeLazyThumbs = installLazyMedia(grid, { root: grid, rootMargin: "200px" });
  }

  // First paint.
  renderControls();
  loadAndRender();
  updateSelectedFooter();
}
