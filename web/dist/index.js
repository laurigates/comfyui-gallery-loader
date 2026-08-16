/* web/dist bundle built by bun from src/ in this repository (see package.json). Inlines @laurigates/comfy-modal-kit (MIT) - a first-party library by the same publisher, published to npm with provenance attestation: https://www.npmjs.com/package/@laurigates/comfy-modal-kit */

// node_modules/@laurigates/comfy-modal-kit/dist/index.js
function installBackGuard(onBack) {
  if (typeof window === "undefined" || typeof history === "undefined")
    return () => {};
  let armed = false;
  let disposed = false;
  const arm = () => {
    history.pushState({ cmpBackGuard: true }, "");
    armed = true;
  };
  const dispose = (opts) => {
    if (disposed)
      return;
    disposed = true;
    window.removeEventListener("popstate", onPop);
    if (armed) {
      armed = false;
      if (opts?.pop !== false)
        history.back();
    }
  };
  function onPop() {
    armed = false;
    let handled = false;
    try {
      handled = onBack();
    } catch (e) {
      console.error("[comfy-modal-kit] back handler threw", e);
    }
    if (handled && !disposed) {
      arm();
      return;
    }
    dispose();
  }
  arm();
  window.addEventListener("popstate", onPop);
  return dispose;
}
var ENTITIES = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;"
};
function escapeHTML(s) {
  return String(s).replace(/[&<>"']/g, (c) => ENTITIES[c]);
}
var KEY = Symbol.for("laurigates.comfyModalKit");
function getKit() {
  const g = globalThis;
  let kit = g[KEY];
  if (!kit) {
    kit = {
      fieldProviders: [],
      modelPickers: [],
      activeModal: null,
      pointerClaim: null,
      modalChrome: [],
      pointerGuardInstalled: false,
      hubEntries: [],
      hubLauncherInstalled: false,
      hubToggles: [],
      safeViewListeners: []
    };
    g[KEY] = kit;
  }
  if (!kit.fieldProviders)
    kit.fieldProviders = [];
  if (!kit.modelPickers)
    kit.modelPickers = [];
  if (!kit.modalChrome)
    kit.modalChrome = [];
  if (!kit.hubEntries)
    kit.hubEntries = [];
  if (!kit.hubToggles)
    kit.hubToggles = [];
  if (!kit.safeViewListeners)
    kit.safeViewListeners = [];
  return kit;
}
var SORT_OPTIONS = [
  { value: "mtime:desc", label: "Newest" },
  { value: "mtime:asc", label: "Oldest" },
  { value: "name:asc", label: "Name A→Z" },
  { value: "name:desc", label: "Name Z→A" },
  { value: "size:desc", label: "Largest file" },
  { value: "size:asc", label: "Smallest file" },
  { value: "pixels:desc", label: "Largest resolution" },
  { value: "pixels:asc", label: "Smallest resolution" },
  { value: "rating:desc", label: "Highest rating" },
  { value: "rating:asc", label: "Lowest rating" }
];
var VALID_SORTS = new Set(SORT_OPTIONS.map((o) => o.value));
function isValidSort(value) {
  return VALID_SORTS.has(value);
}
function sortFiles(files, key, dir) {
  const mul = dir === "asc" ? 1 : -1;
  const nameCmp = (a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" });
  const numCmp = (extract) => (a, b) => (extract(a) ?? 0) - (extract(b) ?? 0) || nameCmp(a, b);
  let cmp;
  switch (key) {
    case "name":
      cmp = nameCmp;
      break;
    case "size":
      cmp = numCmp((f) => f.size);
      break;
    case "pixels":
      cmp = numCmp((f) => f.width && f.height ? f.width * f.height : 0);
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
var IMG_EXTS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".webp",
  ".gif",
  ".bmp",
  ".tiff",
  ".tif",
  ".avif"
]);
var VIDEO_EXTS = new Set([
  ".mp4",
  ".webm",
  ".mov",
  ".mkv",
  ".avi",
  ".m4v",
  ".mpg",
  ".mpeg"
]);
var SANDBOXED_TYPES = ["input", "output", "temp"];
function joinAbs(dir, name) {
  const d = (dir || "/").replace(/\/+$/, "");
  return d === "" ? `/${name}` : `${d}/${name}`;
}
var META_FIELDS = [
  { key: "positive", label: "Positive" },
  { key: "negative", label: "Negative" },
  { key: "model", label: "Model" },
  { key: "seed", label: "Seed" },
  { key: "steps", label: "Steps" },
  { key: "cfg", label: "CFG" },
  { key: "sampler", label: "Sampler" },
  { key: "scheduler", label: "Scheduler" }
];
function metaRows(summary) {
  const rows = [];
  if (!summary || typeof summary !== "object")
    return rows;
  const bag = summary;
  for (const { key, label } of META_FIELDS) {
    const v = bag[key];
    if (v === undefined || v === null)
      continue;
    const value = String(v);
    if (!value.trim())
      continue;
    rows.push({ key, label, value });
  }
  return rows;
}
function metaClipboardText(rows) {
  return rows.map((r) => `${r.label}: ${r.value}`).join(`
`);
}
function createViewStore(namespace) {
  const viewKey = `${namespace}:view`;
  const pendingKey = `${namespace}:view-pending`;
  return {
    load() {
      try {
        if (localStorage.getItem(pendingKey) === "1") {
          localStorage.removeItem(pendingKey);
          localStorage.setItem(viewKey, "folder");
          return { mode: "folder", recovered: true };
        }
        return {
          mode: localStorage.getItem(viewKey) === "flat" ? "flat" : "folder",
          recovered: false
        };
      } catch {
        return { mode: "folder", recovered: false };
      }
    },
    save(mode) {
      try {
        localStorage.setItem(viewKey, mode);
      } catch {}
    },
    markPending(pending) {
      try {
        if (pending)
          localStorage.setItem(pendingKey, "1");
        else
          localStorage.removeItem(pendingKey);
      } catch {}
    }
  };
}
function registerHubToggle(toggle) {
  const list = getKit().hubToggles;
  const i = list.findIndex((t) => t.id === toggle.id);
  if (i >= 0) {
    list.splice(i, 1, toggle);
  } else {
    list.push(toggle);
  }
}
var CHROME_ATTR = "data-cmp-chrome";
function setActiveModal(handle) {
  installPointerGuard();
  dismissActiveModal();
  getKit().activeModal = handle;
}
function dismissActiveModal() {
  const kit = getKit();
  const active = kit.activeModal;
  if (!active)
    return;
  kit.activeModal = null;
  try {
    active.close();
  } catch (e) {
    console.warn("[comfy-modal-kit] active modal close() threw", e);
  }
}
function isModalActive() {
  return getKit().activeModal !== null;
}
function getActiveModal() {
  return getKit().activeModal;
}
function registerModalChrome(el) {
  const chrome = getKit().modalChrome;
  if (!chrome.includes(el))
    chrome.push(el);
  el.setAttribute?.(CHROME_ATTR, "");
}
function unregisterModalChrome(el) {
  const chrome = getKit().modalChrome;
  for (let i = chrome.length - 1;i >= 0; i--) {
    if (chrome[i] === el)
      chrome.splice(i, 1);
  }
  el.removeAttribute?.(CHROME_ATTR);
}
function isModalChrome(node) {
  if (!node)
    return false;
  for (const el2 of getKit().modalChrome) {
    if (el2.contains?.(node))
      return true;
  }
  const el = node.nodeType === 1 ? node : node.parentElement;
  return !!el?.closest?.(`[${CHROME_ATTR}]`);
}
function patchWidgetPointer(widget, opener) {
  const original = widget.onPointerDown;
  function patched(pointer, node, canvas) {
    try {
      if (typeof original === "function") {
        const consumed = original.call(this, pointer, node, canvas);
        if (consumed)
          return consumed;
      }
      return opener(pointer, node, canvas);
    } catch (e) {
      console.warn("[comfy-modal-kit] patched onPointerDown threw", e);
      return false;
    }
  }
  widget.onPointerDown = patched;
  return {
    restore() {
      widget.onPointerDown = original;
    }
  };
}
function installPointerGuard() {
  const kit = getKit();
  if (kit.pointerGuardInstalled)
    return;
  if (typeof window === "undefined")
    return;
  kit.pointerGuardInstalled = true;
  window.addEventListener("pointerdown", pointerGuard, true);
}
function pointerGuard(e) {
  const active = getKit().activeModal;
  if (!active)
    return;
  const target = e.target;
  if (active.element && target && active.element.contains(target)) {
    return;
  }
  if (isModalChrome(target)) {
    return;
  }
  e.stopImmediatePropagation();
  dismissActiveModal();
}
function ensureStyleOnce(id, css) {
  if (typeof document === "undefined")
    return;
  if (document.getElementById(id))
    return;
  const s = document.createElement("style");
  s.id = id;
  s.textContent = css;
  document.head.appendChild(s);
}
var STYLE_ID = "cmn-notify-style";
var CONTAINER_ID = "cmn-notify-container";
function defaultLife(severity) {
  switch (severity) {
    case "error":
      return 0;
    case "warn":
      return 8000;
    default:
      return 4000;
  }
}
function defaultCopyable(severity) {
  return severity === "error" || severity === "warn";
}
function notifyClipboardText(summary, detail) {
  return detail ? `${summary}
${detail}` : summary;
}
async function copyTextToClipboard(text) {
  try {
    if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {}
  try {
    if (typeof document === "undefined")
      return false;
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.top = "-1000px";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    return ok;
  } catch {
    return false;
  }
}
var CSS = `
.cmn-container {
    position: fixed;
    top: 12px;
    right: 12px;
    z-index: 10000;
    display: flex;
    flex-direction: column;
    gap: 8px;
    width: min(380px, calc(100vw - 24px));
    pointer-events: none;
    font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
}
/*
 * While a modal is up, clear the shell header's close button: .cmp-close is a
 * 36px button inside a .cmp-header padded 12px/14px at the dialog's top-right,
 * which lands under the toast's own × — worst case a full-viewport dialog like
 * comfyui-image-browser's .ib-dialog (100vw/100vh), where the two × controls
 * overlap exactly. Applied per raise, so a toast on the bare canvas keeps 12px.
 */
.cmn-container.cmn-modal-inset { top: 64px; }
.cmn-toast {
    pointer-events: auto;
    background: #1a1a1f;
    color: #e8e8ea;
    border: 1px solid #3a3a44;
    border-left-width: 4px;
    border-radius: 8px;
    box-shadow: 0 8px 28px rgba(0, 0, 0, 0.6);
    padding: 10px 12px;
    display: flex;
    flex-direction: column;
    gap: 8px;
    font-size: 13px;
    line-height: 1.4;
    animation: cmn-in 0.16s ease-out;
}
@keyframes cmn-in {
    from { transform: translateY(-8px); opacity: 0; }
    to   { transform: translateY(0);    opacity: 1; }
}
.cmn-toast.cmn-success { border-left-color: #4caf50; }
.cmn-toast.cmn-info    { border-left-color: #6ba6ff; }
.cmn-toast.cmn-warn    { border-left-color: #e0a83a; }
.cmn-toast.cmn-error   { border-left-color: #e0533a; }
.cmn-row {
    display: flex;
    align-items: flex-start;
    gap: 10px;
}
.cmn-text {
    flex: 1;
    min-width: 0;
    word-break: break-word;
}
.cmn-summary { font-weight: 600; }
.cmn-detail  { color: #b8b8c0; margin-top: 2px; white-space: pre-wrap; }
.cmn-close {
    background: transparent;
    color: #aaa;
    border: none;
    cursor: pointer;
    font-size: 18px;
    line-height: 1;
    padding: 0;
    /* Touch-first: a 32px target, with the growth absorbed by a negative margin
       so the toast's visual density is unchanged from the old 24px glyph box. */
    width: 32px;
    height: 32px;
    border-radius: 6px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    margin: -4px -4px 0 0;
    flex-shrink: 0;
}
.cmn-close:hover { color: #fff; }
.cmn-actions { display: flex; gap: 8px; }
.cmn-copy {
    background: #2a2a36;
    color: #d8d8e0;
    border: 1px solid #3a3a44;
    border-radius: 5px;
    /* Touch-first: comfortable tap target, 13px text. */
    min-height: 32px;
    padding: 6px 12px;
    cursor: pointer;
    font-size: 13px;
    font-family: inherit;
    display: inline-flex;
    align-items: center;
    gap: 6px;
}
.cmn-copy:hover  { background: #34343f; color: #fff; }
.cmn-copy.cmn-copied { background: #2f4a30; border-color: #4caf50; color: #cfe8d0; }
`;
function ensureContainer() {
  let c = document.getElementById(CONTAINER_ID);
  if (!c) {
    c = document.createElement("div");
    c.id = CONTAINER_ID;
    c.className = "cmn-container";
    document.body.appendChild(c);
  }
  registerModalChrome(c);
  return c;
}
function notify(opts) {
  const { severity, summary, detail } = opts;
  if (typeof document === "undefined" || !document.body) {
    console.info(`[notify] ${severity}: ${summary}${detail ? ` — ${detail}` : ""}`);
    return null;
  }
  ensureStyleOnce(STYLE_ID, CSS);
  const container = ensureContainer();
  container.classList.toggle("cmn-modal-inset", isModalActive());
  const life = opts.life ?? defaultLife(severity);
  const copyable = opts.copyable ?? defaultCopyable(severity);
  const toast = document.createElement("div");
  toast.className = `cmn-toast cmn-${severity}`;
  toast.setAttribute("role", severity === "error" ? "alert" : "status");
  let timer;
  const close = () => {
    if (timer)
      clearTimeout(timer);
    toast.remove();
    if (container.childElementCount === 0) {
      unregisterModalChrome(container);
      container.remove();
    }
  };
  const row = document.createElement("div");
  row.className = "cmn-row";
  const text = document.createElement("div");
  text.className = "cmn-text";
  const summaryEl = document.createElement("div");
  summaryEl.className = "cmn-summary";
  summaryEl.textContent = summary;
  text.appendChild(summaryEl);
  if (detail) {
    const detailEl = document.createElement("div");
    detailEl.className = "cmn-detail";
    detailEl.textContent = detail;
    text.appendChild(detailEl);
  }
  const closeBtn = document.createElement("button");
  closeBtn.className = "cmn-close";
  closeBtn.type = "button";
  closeBtn.textContent = "×";
  closeBtn.title = "Dismiss";
  closeBtn.addEventListener("click", close);
  row.append(text, closeBtn);
  toast.appendChild(row);
  if (copyable) {
    const actions = document.createElement("div");
    actions.className = "cmn-actions";
    const copyBtn = document.createElement("button");
    copyBtn.className = "cmn-copy";
    copyBtn.type = "button";
    copyBtn.textContent = "Copy";
    copyBtn.addEventListener("click", async () => {
      const ok = await copyTextToClipboard(notifyClipboardText(summary, detail));
      copyBtn.textContent = ok ? "Copied ✓" : "Copy failed";
      copyBtn.classList.toggle("cmn-copied", ok);
      setTimeout(() => {
        copyBtn.textContent = "Copy";
        copyBtn.classList.remove("cmn-copied");
      }, 1500);
    });
    actions.appendChild(copyBtn);
    toast.appendChild(actions);
  }
  container.appendChild(toast);
  if (life > 0) {
    timer = setTimeout(close, life);
  }
  return { close, el: toast };
}
var STYLE_ID2 = "cmp-shell-style";
var CSS2 = `
.cmp-backdrop {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.55);
    z-index: 9998;
    backdrop-filter: blur(2px);
    touch-action: manipulation;
}
.cmp-dialog {
    position: fixed;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
    z-index: 9999;
    width: min(960px, calc(100vw - 24px));
    max-height: min(85vh, 800px);
    touch-action: manipulation;
    display: flex;
    flex-direction: column;
    background: #1a1a1f;
    color: #e8e8ea;
    border: 1px solid #3a3a44;
    border-radius: 10px;
    box-shadow: 0 16px 48px rgba(0, 0, 0, 0.7);
    font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
    font-size: 13px;
    overflow: hidden;
}
.cmp-header {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 12px 14px;
    border-bottom: 1px solid #2a2a32;
    background: #21212a;
    flex-shrink: 0;
}
.cmp-title {
    flex: 1;
    font-weight: 600;
    color: #9ec6ff;
    font-size: 14px;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}
.cmp-subtitle {
    color: #888;
    font-weight: 400;
    font-size: 12px;
    margin-left: 6px;
}
.cmp-close {
    background: transparent;
    color: #aaa;
    border: 1px solid #3a3a44;
    border-radius: 4px;
    /* 44px, not 36: docs/modal-ux-drift-catalog.md:71 sets the family's D02
       target at >=44px, and the Touch Tools chooser cannot credibly promise
       >=44px rows while inheriting a 36px close control. */
    width: 44px;
    height: 44px;
    cursor: pointer;
    font-size: 20px;
    line-height: 1;
    flex-shrink: 0;
}
.cmp-close:hover {
    background: #2a2a32;
    color: #fff;
}
.cmp-toolbar {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    align-items: center;
    padding: 8px 14px;
    border-bottom: 1px solid #2a2a32;
    background: #1f1f26;
    flex-shrink: 0;
}
.cmp-toolbar:empty {
    display: none;
}
.cmp-searchrow {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 10px 14px;
    border-bottom: 1px solid #2a2a32;
    flex-shrink: 0;
}
.cmp-search {
    flex: 1;
    background: #12121a;
    border: 1px solid #3a3a44;
    border-radius: 4px;
    color: #e8e8ea;
    padding: 8px 12px;
    /* 16px prevents iOS auto-zoom on focus. */
    font-size: 16px;
    font-family: inherit;
    outline: none;
    min-width: 0;
}
.cmp-search:focus {
    border-color: #6ba6ff;
}
.cmp-status {
    color: #888;
    font-size: 12px;
    white-space: nowrap;
}
.cmp-body {
    flex: 1;
    overflow-y: auto;
    -webkit-overflow-scrolling: touch;
    overscroll-behavior: contain;
    padding: 8px;
    position: relative;
}
.cmp-body.is-busy {
    opacity: 0.5;
    pointer-events: none;
}
.cmp-footer {
    padding: 8px 14px;
    border-top: 1px solid #2a2a32;
    color: #777;
    font-size: 11px;
    background: #1f1f26;
    flex-shrink: 0;
    display: flex;
    justify-content: space-between;
    gap: 12px;
}
.cmp-footer:empty {
    display: none;
}
.cmp-footer kbd {
    background: #2a2a36;
    border: 1px solid #3a3a44;
    border-bottom-width: 2px;
    border-radius: 3px;
    padding: 1px 5px;
    font-family: ui-monospace, monospace;
    font-size: 10px;
    color: #b8b8c0;
}
`;
function openModalShell(opts = {}) {
  ensureStyleOnce(STYLE_ID2, CSS2);
  const backdrop = document.createElement("div");
  backdrop.className = "cmp-backdrop";
  const dialog = document.createElement("div");
  dialog.className = "cmp-dialog";
  if (opts.width)
    dialog.style.width = opts.width;
  if (opts.height)
    dialog.style.maxHeight = opts.height;
  const stop = (e) => e.stopPropagation();
  for (const ev of ["pointerdown", "pointerup", "click", "dblclick", "wheel"]) {
    dialog.addEventListener(ev, stop);
  }
  const headerEl = document.createElement("div");
  headerEl.className = "cmp-header";
  const titleEl = document.createElement("div");
  titleEl.className = "cmp-title";
  titleEl.textContent = opts.title || "";
  if (opts.subtitle) {
    const sub = document.createElement("span");
    sub.className = "cmp-subtitle";
    sub.textContent = opts.subtitle;
    titleEl.appendChild(sub);
  }
  const closeBtn = document.createElement("button");
  closeBtn.className = "cmp-close";
  closeBtn.type = "button";
  closeBtn.textContent = "×";
  closeBtn.title = "Close (Esc)";
  headerEl.append(titleEl, closeBtn);
  const toolbarEl = document.createElement("div");
  toolbarEl.className = "cmp-toolbar";
  const searchRow = document.createElement("div");
  searchRow.className = "cmp-searchrow";
  const searchEl = document.createElement("input");
  searchEl.type = "search";
  searchEl.className = "cmp-search";
  searchEl.placeholder = opts.placeholder || "Filter…";
  searchEl.spellcheck = false;
  searchEl.autocomplete = "off";
  const statusEl = document.createElement("div");
  statusEl.className = "cmp-status";
  searchRow.append(searchEl, statusEl);
  if (opts.showSearch === false)
    searchRow.style.display = "none";
  const bodyEl = document.createElement("div");
  bodyEl.className = "cmp-body";
  const footerEl = document.createElement("div");
  footerEl.className = "cmp-footer";
  if (opts.showFooter !== false) {
    const l = document.createElement("div");
    if (opts.footerLeftHTML)
      l.innerHTML = opts.footerLeftHTML;
    const r = document.createElement("div");
    if (opts.footerRightHTML)
      r.innerHTML = opts.footerRightHTML;
    footerEl.append(l, r);
  } else {
    footerEl.style.display = "none";
  }
  dialog.append(headerEl, toolbarEl, searchRow, bodyEl, footerEl);
  let torn = false;
  const teardown = () => {
    if (torn)
      return;
    torn = true;
    try {
      backdrop.remove();
      dialog.remove();
      document.removeEventListener("keydown", onKey, true);
      bodyEl.removeEventListener("scroll", onBodyScroll);
    } finally {
      try {
        opts.onClose?.();
      } catch (e) {
        console.warn("[modal-shell] onClose threw", e);
      }
    }
  };
  const handle = { id: "modal-shell", element: dialog, close: teardown };
  const requestClose = () => {
    if (getActiveModal() === handle) {
      dismissActiveModal();
    } else {
      teardown();
    }
  };
  backdrop.addEventListener("pointerdown", requestClose);
  closeBtn.addEventListener("click", requestClose);
  const onKey = (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      requestClose();
      return;
    }
    try {
      opts.onKeyDown?.(e);
    } catch (err) {
      console.warn("[modal-shell] onKeyDown threw", err);
    }
  };
  document.addEventListener("keydown", onKey, true);
  document.body.append(backdrop, dialog);
  let liveScrollTop = 0;
  const onBodyScroll = () => {
    liveScrollTop = bodyEl.scrollTop;
  };
  bodyEl.addEventListener("scroll", onBodyScroll, { passive: true });
  const controller = {
    backdrop,
    dialog,
    headerEl,
    toolbarEl,
    searchEl,
    statusEl,
    bodyEl,
    scrollHost: bodyEl,
    footerEl,
    setBusy(b) {
      bodyEl.classList.toggle("is-busy", !!b);
    },
    setStatus(s) {
      statusEl.textContent = s || "";
    },
    getScrollTop() {
      if (bodyEl.isConnected)
        liveScrollTop = bodyEl.scrollTop;
      return liveScrollTop;
    },
    close: requestClose,
    _onKey: onKey,
    opts
  };
  setActiveModal(handle);
  if (opts.showSearch !== false) {
    requestAnimationFrame(() => {
      if (getActiveModal() === handle)
        searchEl.focus();
    });
  }
  return controller;
}
var DEFAULT_SELECTOR = "img[data-src], video[data-src]";
function installLazyMedia(container, opts) {
  const noop = () => {};
  if (typeof IntersectionObserver === "undefined")
    return noop;
  const els = container.querySelectorAll(opts.selector ?? DEFAULT_SELECTOR);
  if (!els.length)
    return noop;
  const io = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (!e.isIntersecting)
        continue;
      const el = e.target;
      const src = el.dataset.src;
      if (src) {
        if (el.tagName === "VIDEO")
          el.preload = "metadata";
        el.src = src;
        el.removeAttribute("data-src");
      }
      io.unobserve(el);
    }
  }, { root: opts.root, rootMargin: opts.rootMargin ?? "300px" });
  for (const el of els)
    io.observe(el);
  return () => io.disconnect();
}
function fuzzyScore(query, target) {
  if (!query)
    return { score: 0, matches: [] };
  if (!target)
    return null;
  const q = query.toLowerCase();
  const t = target.toLowerCase();
  const matches = [];
  let qi = 0;
  let score = 0;
  let consecutive = 0;
  let prevMatchIdx = -1;
  for (let ti = 0;ti < t.length && qi < q.length; ti++) {
    if (t[ti] !== q[qi]) {
      consecutive = 0;
      continue;
    }
    let charScore = 1;
    if (ti === 0) {
      charScore += 5;
    } else {
      const prev = t[ti - 1];
      const orig = target[ti];
      if (prev === "_" || prev === "-" || prev === " " || prev === "." || prev === "/") {
        charScore += 4;
      } else if (prev !== undefined && prev >= "a" && prev <= "z" && orig !== undefined && orig >= "A" && orig <= "Z") {
        charScore += 3;
      }
    }
    if (ti === prevMatchIdx + 1) {
      consecutive++;
      charScore += consecutive * 2;
    } else {
      consecutive = 0;
    }
    score += charScore;
    matches.push(ti);
    prevMatchIdx = ti;
    qi++;
  }
  if (qi < q.length)
    return null;
  score -= target.length * 0.01;
  return { score, matches };
}
function highlightMatches(target, matchIndices) {
  const frag = document.createDocumentFragment();
  if (!target)
    return frag;
  const set = new Set(matchIndices || []);
  if (!set.size) {
    frag.appendChild(document.createTextNode(target));
    return frag;
  }
  for (let i = 0;i < target.length; i++) {
    const ch = target[i];
    if (set.has(i)) {
      const m = document.createElement("span");
      m.className = "cmp-match";
      m.textContent = ch;
      frag.appendChild(m);
    } else {
      frag.appendChild(document.createTextNode(ch));
    }
  }
  return frag;
}
var MAX_RATING = 5;
function ratingOf(f) {
  const r = f.rating;
  return typeof r === "number" && r > 0 ? Math.min(MAX_RATING, Math.floor(r)) : 0;
}
function nextRating(cur, val) {
  return val === cur ? 0 : val;
}
function ratingRequestBody(addr, rating) {
  if (addr.type === "path") {
    return { type: "path", path: addr.absDir, name: addr.name, rating };
  }
  return { type: addr.type, subfolder: addr.subfolder, name: addr.name, rating };
}
async function postRating(url, addr, rating) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(ratingRequestBody(addr, rating))
  });
  if (!res.ok)
    throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  if (!data.ok)
    throw new Error(data.error || "rating failed");
  return typeof data.rating === "number" ? data.rating : rating;
}
function starsHTML(prefix, rating) {
  const r = ratingOf({ rating });
  let buttons = "";
  for (let i = 1;i <= MAX_RATING; i++) {
    const on = i <= r ? " is-on" : "";
    buttons += `<button type="button" class="${prefix}-star${on}" data-val="${i}" tabindex="-1">★</button>`;
  }
  return `<div class="${prefix}-stars" data-rating="${r}" title="Rate (click the active star to clear)">${buttons}</div>`;
}
function applyStars(row, rating) {
  const r = ratingOf({ rating });
  row.dataset.rating = String(r);
  for (const s of row.querySelectorAll("[data-val]")) {
    s.classList.toggle("is-on", Number(s.dataset.val) <= r);
  }
}
function warnRating(extName, e) {
  console.warn(`[${extName}] rating update failed`, e);
}
var SAFE_VIEW_SETTINGS = {
  enabled: "TouchTools.SafeView.Enabled",
  keywords: "TouchTools.SafeView.Keywords",
  hide: "TouchTools.SafeView.Hide",
  blurNames: "TouchTools.SafeView.BlurNames",
  matchPrompt: "TouchTools.SafeView.MatchPrompt"
};
var SAFE_VIEW_DEFAULT_KEYWORDS = "nsfw";
var SAFE_VIEW_GLYPH_ON = "\uD83D\uDE48";
var SAFE_VIEW_GLYPH_OFF = "\uD83D\uDC41";
function safeViewSettings() {
  const fire = () => notifySafeViewChange();
  return [
    {
      id: SAFE_VIEW_SETTINGS.enabled,
      category: ["Touch Tools", "Safe View", "Enabled"],
      sortOrder: 100,
      name: "Safe View",
      tooltip: "Blur thumbnails and block out names for files and folders matching your keywords, in the Image Browser, the image picker and ComfyUI's own asset sidebar and lightbox. This is discretion, not security: the blur is CSS and the file is still downloaded, so it defeats someone glancing over your shoulder, not someone with your keyboard.",
      type: "boolean",
      defaultValue: true,
      onChange: fire
    },
    {
      id: SAFE_VIEW_SETTINGS.keywords,
      category: ["Touch Tools", "Safe View", "Keywords"],
      sortOrder: 90,
      name: "Keywords",
      tooltip: "Comma- or space-separated. Matched as WHOLE WORDS against the file name, every folder above it, and the file's XMP keyword tags — so 'nsfw' matches output/nsfw/pic.png and my_nsfw_pic.png, while 'ass' does not match assets/ or classic.png. Case-insensitive. Empty means nothing is filtered.",
      type: "text",
      defaultValue: SAFE_VIEW_DEFAULT_KEYWORDS,
      onChange: fire
    },
    {
      id: SAFE_VIEW_SETTINGS.hide,
      category: ["Touch Tools", "Safe View", "Hide"],
      sortOrder: 80,
      name: "Remove matches from the listing entirely",
      tooltip: "Off (default): matches stay in the grid, blurred, with a reveal button. On: matches are dropped server-side, so they never reach the browser and the listing count changes. Hiding is filtered above the newest-N cap, so a folder of mostly-sensitive files still returns a full page of the rest.",
      type: "boolean",
      defaultValue: false,
      onChange: fire
    },
    {
      id: SAFE_VIEW_SETTINGS.blurNames,
      category: ["Touch Tools", "Safe View", "Names"],
      sortOrder: 70,
      name: "Block out names too",
      tooltip: "Replaces the file name, its folder label and its tooltip with a solid block. Off leaves names readable under a blurred thumbnail — which usually defeats the point, since the folder name is often what matched.",
      type: "boolean",
      defaultValue: true,
      onChange: fire
    },
    {
      id: SAFE_VIEW_SETTINGS.matchPrompt,
      category: ["Touch Tools", "Safe View", "Prompt"],
      sortOrder: 60,
      name: "Also match the generation prompt and model",
      tooltip: "Off by default because it is expensive: every file's embedded metadata must be parsed and cached before its verdict is known, and a file with no verdict yet is blurred until the background scan reaches it. On a large library that means a mostly-blurred grid on first enable, clearing as the scan progresses.",
      type: "boolean",
      defaultValue: false,
      onChange: fire
    }
  ];
}
function safeViewSettingHost() {
  const host = globalThis;
  return host.app?.extensionManager?.setting ?? null;
}
var SAFE_VIEW_DEFAULTS = Object.freeze({
  enabled: true,
  keywords: Object.freeze([SAFE_VIEW_DEFAULT_KEYWORDS]),
  hide: false,
  blurNames: true,
  matchPrompt: false
});
function parseKeywords(raw) {
  if (typeof raw !== "string")
    return [];
  const out = [];
  const seen = new Set;
  for (const piece of raw.split(/[\s,]+/)) {
    const kw = piece.toLowerCase().replace(/[^a-z0-9]/g, "");
    if (!kw || seen.has(kw))
      continue;
    seen.add(kw);
    out.push(kw);
  }
  return out;
}
function readSafeViewConfig(host = safeViewSettingHost()) {
  if (!host)
    return SAFE_VIEW_DEFAULTS;
  const bool = (id, fallback) => {
    const v = host.get(id);
    return typeof v === "boolean" ? v : fallback;
  };
  const rawKeywords = host.get(SAFE_VIEW_SETTINGS.keywords);
  return {
    enabled: bool(SAFE_VIEW_SETTINGS.enabled, SAFE_VIEW_DEFAULTS.enabled),
    keywords: rawKeywords === undefined ? SAFE_VIEW_DEFAULTS.keywords : parseKeywords(rawKeywords),
    hide: bool(SAFE_VIEW_SETTINGS.hide, SAFE_VIEW_DEFAULTS.hide),
    blurNames: bool(SAFE_VIEW_SETTINGS.blurNames, SAFE_VIEW_DEFAULTS.blurNames),
    matchPrompt: bool(SAFE_VIEW_SETTINGS.matchPrompt, SAFE_VIEW_DEFAULTS.matchPrompt)
  };
}
function isSafeViewActive(cfg = readSafeViewConfig()) {
  return cfg.enabled && cfg.keywords.length > 0;
}
function sensitiveKeyword(cfg) {
  return cfg.keywords.length ? cfg.keywords[0] : null;
}
function tokenize(input) {
  if (typeof input !== "string" || input === "")
    return [];
  return input.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t !== "");
}
function isSensitive(target, cfg) {
  if (!cfg.enabled || cfg.keywords.length === 0)
    return false;
  const haystack = new Set;
  for (const t of tokenize(target.name))
    haystack.add(t);
  for (const t of tokenize(target.path))
    haystack.add(t);
  for (const tag of target.tags ?? []) {
    for (const t of tokenize(tag))
      haystack.add(t);
  }
  for (const kw of cfg.keywords) {
    if (haystack.has(kw))
      return true;
  }
  if (cfg.matchPrompt) {
    if (target.promptMatch === true)
      return true;
    if (target.promptMatch === "unscanned")
      return true;
  }
  return false;
}
function makeRevealSet() {
  const set = new Set;
  const key = (type, subfolder, name) => `${type}:${subfolder}:${name}`;
  return {
    key,
    has: (t, s, n) => set.has(key(t, s, n)),
    reveal: (t, s, n) => {
      set.add(key(t, s, n));
    },
    clear: () => set.clear(),
    get size() {
      return set.size;
    }
  };
}
var SAFE_VIEW_STYLE_ID = "cmk-safe-view-style";
var SAFE_VIEW_BLUR_CLASS = "cmk-sv-blur";
var SAFE_VIEW_SPOILER_CLASS = "cmk-sv-spoiler";
var SPOILER_TITLE_ATTR = "data-cmk-sv-title";
var SAFE_VIEW_CSS = `
.${SAFE_VIEW_BLUR_CLASS} {
    /* Scale past the edges: a blurred element otherwise fades toward its own
       border and leaks a readable silhouette of the content at the rim. */
    filter: blur(18px);
    transform: scale(1.08);
}
.${SAFE_VIEW_SPOILER_CLASS} {
    /* A SOLID BLOCK, never a text blur — blurred text stays readable at small
       sizes, which is exactly the size a phone grid renders names at. */
    background: #3a3a44;
    color: transparent;
    border-radius: 3px;
    user-select: none;
    -webkit-user-select: none;
    cursor: default;
}
.cmk-sv-reveal {
    position: absolute;
    top: 4px;
    left: 4px;
    z-index: 2;
    /* >=34px is the family's per-card control floor. */
    min-width: 34px;
    min-height: 34px;
    padding: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 15px;
    line-height: 1;
    background: rgba(20, 20, 26, 0.82);
    color: #e8e8ea;
    border: 1px solid #4a4a58;
    border-radius: 8px;
    cursor: pointer;
    touch-action: manipulation;
}
.cmk-sv-reveal:hover {
    background: rgba(40, 40, 52, 0.92);
}
`;
function ensureSafeViewStyle() {
  ensureStyleOnce(SAFE_VIEW_STYLE_ID, SAFE_VIEW_CSS);
}
function setBlurred(el, blurred) {
  ensureSafeViewStyle();
  el.classList.toggle(SAFE_VIEW_BLUR_CLASS, blurred);
}
function setSpoilered(el, spoilered) {
  ensureSafeViewStyle();
  el.classList.toggle(SAFE_VIEW_SPOILER_CLASS, spoilered);
  if (spoilered) {
    const title = el.getAttribute("title");
    if (title !== null) {
      el.setAttribute(SPOILER_TITLE_ATTR, title);
      el.removeAttribute("title");
    }
  } else {
    const parked = el.getAttribute(SPOILER_TITLE_ATTR);
    if (parked !== null) {
      el.setAttribute("title", parked);
      el.removeAttribute(SPOILER_TITLE_ATTR);
    }
  }
}
function makeRevealButton(opts) {
  ensureSafeViewStyle();
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "cmk-sv-reveal";
  btn.textContent = SAFE_VIEW_GLYPH_OFF;
  btn.title = "Reveal";
  btn.setAttribute("aria-label", opts.label ?? "Reveal hidden item");
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    e.preventDefault();
    opts.onReveal();
  });
  return btn;
}
function onSafeViewChange(listener) {
  const list = getKit().safeViewListeners;
  list.push(listener);
  return () => {
    const i = list.indexOf(listener);
    if (i >= 0)
      list.splice(i, 1);
  };
}
function notifySafeViewChange() {
  for (const listener of [...getKit().safeViewListeners]) {
    try {
      listener();
    } catch (e) {
      console.error("[comfy-modal-kit] safe-view listener failed", e);
    }
  }
}
function toggleSafeView(host = safeViewSettingHost()) {
  if (!host)
    return;
  const cfg = readSafeViewConfig(host);
  if (cfg.keywords.length === 0) {
    notify({
      severity: "warn",
      summary: "Safe View has no keywords",
      detail: "Add keywords in Settings → Touch Tools → Safe View → Keywords."
    });
    return;
  }
  host.set(SAFE_VIEW_SETTINGS.enabled, !cfg.enabled);
}
function registerSafeViewHubToggle() {
  registerHubToggle({
    id: "safe-view.toggle",
    label: "Safe View",
    icon: "pi pi-eye-slash",
    description: "Blur sensitive thumbnails and names",
    priority: 100,
    get: () => isSafeViewActive(),
    set: () => toggleSafeView()
  });
}
var SCROLL_RESTORE_FRAMES = 12;
var NATIVE_SCROLL_KEYS = new Set([
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "PageUp",
  "PageDown",
  "Home",
  "End"
]);
var GESTURE_EVENTS = ["pointerdown", "wheel", "touchstart"];
function defaultIsTypingTarget() {
  const el = typeof document === "undefined" ? null : document.activeElement;
  if (!el)
    return false;
  if (el.isContentEditable)
    return true;
  const tag = el.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}
function installScrollRestore(host, opts) {
  const frames = Math.max(0, opts?.frames ?? SCROLL_RESTORE_FRAMES);
  const isTyping = opts?.isTypingTarget ?? defaultIsTypingTarget;
  const keyTarget = opts?.keyTarget ?? (typeof window === "undefined" ? null : window);
  let liveScrollTop = 0;
  let userTookOver = false;
  let raf = 0;
  const onScroll = () => {
    liveScrollTop = host.scrollTop;
  };
  host.addEventListener("scroll", onScroll, { passive: true });
  function cancel() {
    if (raf !== 0) {
      cancelAnimationFrame(raf);
      raf = 0;
    }
  }
  function yieldScroller() {
    userTookOver = true;
    cancel();
  }
  for (const ev of GESTURE_EVENTS) {
    host.addEventListener(ev, yieldScroller, { passive: true, capture: true });
  }
  const onKey = (e) => {
    const key = e.key;
    if (!NATIVE_SCROLL_KEYS.has(key) || isTyping())
      return;
    yieldScroller();
  };
  keyTarget?.addEventListener("keydown", onKey, true);
  function current() {
    if (host.isConnected)
      liveScrollTop = host.scrollTop;
    return liveScrollTop;
  }
  function set(top) {
    host.scrollTop = top;
    liveScrollTop = host.scrollTop;
  }
  function restore(target) {
    cancel();
    userTookOver = false;
    set(target);
    if (target <= 0)
      return;
    if (typeof requestAnimationFrame !== "function" || host.clientHeight <= 0)
      return;
    if (frames <= 0)
      return;
    let n = 0;
    const step = () => {
      raf = 0;
      if (userTookOver || !host.isConnected)
        return;
      const max = Math.max(0, host.scrollHeight - host.clientHeight);
      const reachable = Math.min(target, max);
      if (Math.abs(host.scrollTop - reachable) > 1)
        set(reachable);
      if (++n >= frames)
        return;
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
  }
  return {
    host,
    current,
    set,
    restore,
    cancel,
    sync() {
      liveScrollTop = host.scrollTop;
    },
    dispose() {
      cancel();
      host.removeEventListener("scroll", onScroll);
      for (const ev of GESTURE_EVENTS) {
        host.removeEventListener(ev, yieldScroller, true);
      }
      keyTarget?.removeEventListener("keydown", onKey, true);
    }
  };
}
function createScrollMemory() {
  const slots = new Map;
  return {
    get(key) {
      return slots.get(key) ?? 0;
    },
    remember(key, top) {
      slots.set(key, top);
    },
    forget(key) {
      slots.delete(key);
    },
    get size() {
      return slots.size;
    }
  };
}
var STYLE_ID3 = "cmp-overlay-style";
var CSS3 = `
.cmp-ov-backdrop {
    position: absolute;
    inset: 0;
    z-index: 5;
    background: rgba(0, 0, 0, 0.55);
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 16px;
    touch-action: manipulation;
}
.cmp-ov-card {
    background: #1c1c24;
    border: 1px solid #33333f;
    border-radius: 10px;
    padding: 18px;
    width: min(520px, calc(100% - 24px));
    max-height: calc(100% - 24px);
    display: flex;
    flex-direction: column;
    gap: 12px;
    box-shadow: 0 12px 40px rgba(0, 0, 0, 0.5);
}
.cmp-ov-title { font-size: 15px; font-weight: 600; color: #e8e8ec; }
.cmp-ov-msg { font-size: 13px; color: #b8b8c0; line-height: 1.5; word-break: break-word; }
.cmp-ov-input {
    font-size: 16px;
    padding: 10px 12px;
    background: #12121a;
    border: 1px solid #3a3a44;
    border-radius: 6px;
    color: #e8e8ec;
    font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
}
.cmp-ov-input:focus { outline: none; border-color: #6ba6ff; }
.cmp-ov-err { font-size: 12px; color: #ff7a7a; min-height: 14px; }
.cmp-ov-actions { display: flex; justify-content: flex-end; gap: 8px; }
.cmp-ov-btn {
    font-size: 13px;
    padding: 9px 16px;
    border-radius: 6px;
    border: 1px solid #3a3a44;
    background: #2a2a36;
    color: #d8d8dc;
    cursor: pointer;
    font-family: inherit;
    min-height: 38px;
}
.cmp-ov-btn:hover { background: #3a3a4a; color: #fff; }
.cmp-ov-primary { background: #2f3a52; color: #9ec6ff; border-color: #4a5878; }
.cmp-ov-primary:hover { background: #3a4868; color: #fff; }
.cmp-ov-danger { background: #4a2230; color: #ff9eb0; border-color: #78384a; }
.cmp-ov-danger:hover { background: #5c2a3c; color: #fff; }
`;
function openShellOverlay(shell, opts = {}) {
  ensureStyleOnce(STYLE_ID3, CSS3);
  const backdrop = document.createElement("div");
  backdrop.className = "cmp-ov-backdrop";
  const card = document.createElement("div");
  card.className = "cmp-ov-card";
  backdrop.appendChild(card);
  const onKey = (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      dismiss();
    }
  };
  let closed = false;
  function close() {
    if (closed)
      return;
    closed = true;
    document.removeEventListener("keydown", onKey, true);
    document.addEventListener("keydown", shell._onKey, true);
    backdrop.remove();
  }
  function dismiss() {
    opts.onDismiss?.();
    close();
  }
  backdrop.addEventListener("pointerdown", (e) => {
    if (e.target === backdrop)
      dismiss();
  });
  document.removeEventListener("keydown", shell._onKey, true);
  document.addEventListener("keydown", onKey, true);
  shell.dialog.appendChild(backdrop);
  return { card, close };
}
function appendButtonWidget(node, label, onClick, opts = {}) {
  const prefix = opts.logPrefix ? `[${opts.logPrefix}]` : "[comfy-modal-kit]";
  try {
    const btn = node.addWidget?.("button", label, null, () => {
      try {
        onClick();
      } catch (e) {
        console.warn(`${prefix} open from button failed`, e);
      }
    }, { serialize: false });
    if (btn)
      btn.serialize = false;
    if (btn && node.widgets) {
      const idx = node.widgets.indexOf(btn);
      if (idx !== -1 && idx !== node.widgets.length - 1) {
        node.widgets.splice(idx, 1);
        node.widgets.push(btn);
      }
    }
    node.setDirtyCanvas?.(true, true);
  } catch (e) {
    console.warn(`${prefix} addWidget(button) failed`, e);
  }
}

// src/gallery_loader.ts
import { app } from "/scripts/app.js";

// src/safe-tag.ts
var TAG_URL = "/gallery_loader/tag";
function hasSensitiveTag(f, keyword) {
  const want = keyword.toLowerCase();
  return (f.tags ?? []).some((t) => t.toLowerCase() === want);
}
function tagRequestBody(addr, tag, present) {
  if (addr.type === "path") {
    return { type: "path", path: addr.absDir, name: addr.name, tag, present };
  }
  return { type: addr.type, subfolder: addr.subfolder, name: addr.name, tag, present };
}
async function postTag(url, addr, tag, present) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(tagRequestBody(addr, tag, present))
  });
  if (!res.ok)
    throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  if (!data.ok)
    throw new Error(data.error || "tag failed");
  return Array.isArray(data.tags) ? data.tags : [];
}
function markSensitiveHTML(prefix, keyword, marked) {
  const label = marked ? `Unmark sensitive (removes ‘${keyword}’)` : `Mark sensitive (‘${keyword}’)`;
  return `<button type="button" class="${prefix}-mark-sensitive${marked ? " is-marked" : ""}" aria-pressed="${marked}" title="${label}" aria-label="${label}">\uD83D\uDE48</button>`;
}

// src/gallery_loader.ts
var EXT_NAME = "comfyui-gallery-loader";
var NODE = "GalleryLoadImage";
var LIST_URL = "/gallery_loader/list";
var RATING_URL = "/gallery_loader/rating";
var CSS_URL = "/extensions/comfyui-gallery-loader/css/gallery_loader.css";
if (!document.querySelector(`link[href="${CSS_URL}"]`)) {
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = CSS_URL;
  document.head.appendChild(link);
}
var TYPES = ["input", "output", "temp", "path"];
var SORT_STORAGE_KEY = "comfyui-gallery-loader:sort";
function loadSavedSort() {
  try {
    const raw = localStorage.getItem(SORT_STORAGE_KEY);
    if (!raw || !isValidSort(raw))
      return null;
    const [key, dir] = raw.split(":");
    return key && dir ? { key, dir } : null;
  } catch {
    return null;
  }
}
function saveSort(key, dir) {
  try {
    localStorage.setItem(SORT_STORAGE_KEY, `${key}:${dir}`);
  } catch {}
}
var MIN_NODE_W = 360;
var MIN_NODE_H = 460;
app.registerExtension({
  name: "comfy.gallery-loader",
  async beforeRegisterNodeDef(nodeType, nodeData) {
    const data = nodeData;
    if (data.name !== NODE)
      return;
    const proto = nodeType.prototype;
    const orig = proto.onNodeCreated;
    proto.onNodeCreated = function(...args) {
      const r = orig?.apply(this, args);
      try {
        attachGallery(this);
      } catch (e) {
        console.error("[gallery_loader] attach failed:", e);
      }
      return r;
    };
  }
});
function parseAnnotated(value) {
  const v = (typeof value === "string" ? value : "").trim();
  if (!v)
    return { type: "input", subfolder: "", name: "", isAbs: false };
  const m = v.match(/^(.*?)\s*\[(input|output|temp)\]\s*$/);
  if (m) {
    const rel = m[1].replace(/\\/g, "/");
    const idx2 = rel.lastIndexOf("/");
    return {
      type: m[2],
      subfolder: idx2 >= 0 ? rel.slice(0, idx2) : "",
      name: idx2 >= 0 ? rel.slice(idx2 + 1) : rel,
      isAbs: false
    };
  }
  if (v.startsWith("/") || /^[A-Za-z]:[\\/]/.test(v)) {
    const norm = v.replace(/\\/g, "/");
    const idx2 = norm.lastIndexOf("/");
    return {
      type: "path",
      subfolder: idx2 >= 0 ? norm.slice(0, idx2) : "",
      name: idx2 >= 0 ? norm.slice(idx2 + 1) : norm,
      isAbs: true
    };
  }
  const idx = v.lastIndexOf("/");
  return {
    type: "input",
    subfolder: idx >= 0 ? v.slice(0, idx) : "",
    name: idx >= 0 ? v.slice(idx + 1) : v,
    isAbs: false
  };
}
function buildAnnotated(type, subfolder, name) {
  if (type === "path") {
    if (subfolder)
      return `${subfolder.replace(/\/$/, "")}/${name}`;
    return name;
  }
  const sub = (subfolder || "").replace(/^\/+|\/+$/g, "");
  const rel = sub ? `${sub}/${name}` : name;
  return `${rel} [${type}]`;
}
function thumbURL(type, subfolder, f, absDir) {
  const v = `${f.mtime}-${f.size ?? 0}`;
  if (type === "path") {
    const full = `${(absDir || "").replace(/\/$/, "")}/${f.name}`;
    return `/gallery_loader/thumb?path=${encodeURIComponent(full)}&v=${encodeURIComponent(v)}`;
  }
  const params = new URLSearchParams({
    type,
    subfolder: subfolder || "",
    name: f.name,
    v
  });
  return `/gallery_loader/thumb?${params.toString()}`;
}
function attachGallery(node) {
  const found = node.widgets?.find((w) => w.name === "image");
  if (!found)
    return;
  const widget = found;
  widget.hidden = true;
  widget.options = widget.options || {};
  widget.options.hidden = true;
  widget.computeSize = () => [0, -4];
  for (const key of ["element", "inputEl"]) {
    const el = widget[key];
    if (el?.style)
      el.style.display = "none";
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
  const chipsEl = root.querySelector(".gl-chips");
  for (const t of TYPES) {
    const b = document.createElement("button");
    b.className = "gl-chip";
    b.dataset.type = t;
    b.textContent = t;
    chipsEl.appendChild(b);
  }
  const initial = parseAnnotated(widget.value);
  const state = {
    type: initial.type,
    subfolder: initial.subfolder,
    absDir: initial.isAbs ? initial.subfolder : "",
    search: "",
    sortKey: "mtime",
    sortDir: "desc",
    dirs: [],
    files: [],
    selectedName: initial.name
  };
  const savedSort = loadSavedSort();
  if (savedSort) {
    state.sortKey = savedSort.key;
    state.sortDir = savedSort.dir;
  }
  const refs = {
    grid: root.querySelector(".gl-grid"),
    status: root.querySelector(".gl-status"),
    crumbs: root.querySelector(".gl-crumbs"),
    chips: chipsEl,
    search: root.querySelector(".gl-search"),
    path: root.querySelector(".gl-pathinput"),
    selected: root.querySelector(".gl-selected"),
    refresh: root.querySelector(".gl-refresh"),
    sort: root.querySelector(".gl-sort"),
    safeView: root.querySelector(".gl-safe-view")
  };
  const revealSet = makeRevealSet();
  function safeViewPath() {
    if (state.type === "path")
      return state.absDir || "";
    return state.subfolder ? `${state.type}/${state.subfolder}` : state.type;
  }
  function renderSafeViewToggle() {
    const on = isSafeViewActive();
    refs.safeView.textContent = on ? SAFE_VIEW_GLYPH_ON : SAFE_VIEW_GLYPH_OFF;
    refs.safeView.classList.toggle("is-active", on);
    refs.safeView.title = on ? "Safe View on — matching thumbnails are blurred. Tap to show everything." : "Safe View off — tap to blur thumbnails matching your keywords.";
    refs.safeView.setAttribute("aria-pressed", String(on));
  }
  refs.safeView.addEventListener("click", () => {
    toggleSafeView();
  });
  function safeHideKeywords() {
    const cfg = readSafeViewConfig();
    return cfg.hide && isSafeViewActive(cfg) ? cfg.keywords.join(",") : "";
  }
  let lastSafeHideKeywords = safeHideKeywords();
  const disposeSafeViewSub = onSafeViewChange(() => {
    if (!root.isConnected) {
      disposeSafeViewSub();
      return;
    }
    renderSafeViewToggle();
    const kw = safeHideKeywords();
    if (kw !== lastSafeHideKeywords) {
      loadAndRender();
      return;
    }
    renderGrid();
  });
  function applySafeView(card, cfg, onReveal) {
    card.classList.add("is-safe-hidden");
    const media = card.querySelector(".gl-thumb img");
    if (media)
      setBlurred(media, true);
    if (cfg.blurNames) {
      for (const el of card.querySelectorAll(".gl-name"))
        setSpoilered(el, true);
    }
    const host = card.querySelector(".gl-thumb") ?? card;
    host.appendChild(makeRevealButton({ onReveal }));
  }
  refs.sort.innerHTML = SORT_OPTIONS.map((o) => `<option value="${o.value}">${escapeHTML(o.label)}</option>`).join("");
  refs.sort.value = `${state.sortKey}:${state.sortDir}`;
  refs.sort.addEventListener("change", (e) => {
    const [key, dir] = e.target.value.split(":");
    state.sortKey = key;
    state.sortDir = dir;
    saveSort(key, dir);
    renderGrid();
  });
  chipsEl.addEventListener("click", (e) => {
    const t = e.target.closest(".gl-chip");
    if (!t)
      return;
    state.type = t.dataset.type;
    if (state.type !== "path")
      state.subfolder = "";
    renderControls();
    loadAndRender();
  });
  refs.refresh.addEventListener("click", () => loadAndRender());
  refs.search.addEventListener("input", (e) => {
    state.search = e.target.value.toLowerCase();
    renderGrid();
  });
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
  refs.crumbs.addEventListener("click", (e) => {
    const seg = e.target.closest("[data-crumb]");
    if (!seg)
      return;
    if (state.type === "path") {
      state.absDir = seg.dataset.crumb || "/";
    } else {
      state.subfolder = seg.dataset.crumb || "";
    }
    loadAndRender();
  });
  refs.grid.addEventListener("click", (e) => {
    const mark = e.target.closest(".gl-mark-sensitive");
    if (mark) {
      e.stopPropagation();
      const card2 = mark.closest(".gl-card");
      const f = card2 ? state.files.find((x) => x.name === card2.dataset.name) : undefined;
      if (f)
        toggleSensitiveTag(f, mark);
      return;
    }
    const star = e.target.closest(".gl-star");
    if (star) {
      const card2 = star.closest(".gl-card");
      const row = star.parentElement;
      if (card2 && row) {
        const cur = Number(row.dataset.rating || "0");
        setStarRating(card2.dataset.name, row, nextRating(cur, Number(star.dataset.val)));
      }
      return;
    }
    const card = e.target.closest(".gl-card");
    if (!card)
      return;
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
      const name = card.dataset.name;
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
      state.selectedName = card.dataset.name;
      commitSelection();
      renderGrid();
    }
  });
  const stop = (e) => e.stopPropagation();
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
    "keyup"
  ]) {
    root.addEventListener(ev, stop, { capture: false });
  }
  refs.grid.addEventListener("wheel", (e) => {
    refs.grid.scrollTop += e.deltaY;
    e.preventDefault();
    e.stopPropagation();
  }, { passive: false });
  node.addDOMWidget("gl_gallery", "gallery", root, {
    serialize: false,
    hideOnZoom: true,
    getMinHeight: () => 360
  });
  if (node.size[0] < MIN_NODE_W)
    node.size[0] = MIN_NODE_W;
  if (node.size[1] < MIN_NODE_H)
    node.size[1] = MIN_NODE_H;
  function renderControls() {
    for (const c of chipsEl.querySelectorAll(".gl-chip")) {
      c.classList.toggle("is-active", c.dataset.type === state.type);
    }
    refs.path.style.display = state.type === "path" ? "" : "none";
    if (state.type === "path")
      refs.path.value = state.absDir || "";
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
  let revealLocation = null;
  function locationKey() {
    return state.type === "path" ? `path:${state.absDir}` : `${state.type}:${state.subfolder}`;
  }
  async function loadAndRender() {
    lastSafeHideKeywords = safeHideKeywords();
    const here = locationKey();
    if (revealLocation !== null && revealLocation !== here)
      revealSet.clear();
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
      const kw = safeHideKeywords();
      if (kw) {
        params.set("safe_kw", kw);
        params.set("safe_hide", "1");
      }
      const res = await fetch(`${LIST_URL}?${params.toString()}`);
      if (!res.ok)
        throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      if (!data.ok)
        throw new Error(data.error || "list failed");
      state.dirs = data.dirs || [];
      state.files = data.files || [];
      refs.status.textContent = data.exists ? `${state.dirs.length} dir, ${state.files.length} img` : "Directory not found.";
    } catch (e) {
      console.error("[gallery_loader] list failed:", e);
      refs.status.textContent = `Error: ${e.message}`;
      state.dirs = [];
      state.files = [];
    }
    refs.grid.classList.remove("is-loading");
    renderGrid();
  }
  function renderGrid() {
    const grid = refs.grid;
    grid.innerHTML = "";
    const svCfg = readSafeViewConfig();
    const safeKeyword = sensitiveKeyword(svCfg);
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
      if (q && !d.name.toLowerCase().includes(q))
        continue;
      const c = document.createElement("div");
      c.className = "gl-card is-dir";
      c.dataset.name = d.name;
      c.innerHTML = `<div class="gl-thumb gl-folder">\uD83D\uDCC1</div><div class="gl-name" title="${escapeHTML(d.name)}">${escapeHTML(d.name)}</div>`;
      if (isSensitive({ name: d.name }, svCfg) && !revealSet.has(state.type, state.subfolder, d.name)) {
        applySafeView(c, svCfg, () => {
          revealSet.reveal(state.type, state.subfolder, d.name);
          renderGrid();
        });
      }
      grid.appendChild(c);
    }
    let sortedFiles;
    if (q) {
      const scored = [];
      for (const f of state.files) {
        const r = fuzzyScore(q, f.name);
        if (r)
          scored.push({ f, score: r.score });
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
      const titleText = dims ? `${f.name}
${dims}
${stamp}` : `${f.name}
${stamp}`;
      const markBtn = safeKeyword ? markSensitiveHTML("gl", safeKeyword, hasSensitiveTag(f, safeKeyword)) : "";
      c.innerHTML = `
                <div class="gl-thumb"><img loading="lazy" decoding="async" data-src="${url}" alt="">${markBtn}</div>
                <div class="gl-name" title="${escapeHTML(titleText)}">${escapeHTML(f.name)}</div>
                ${dims ? `<div class="gl-dims">${dims}</div>` : ""}
                ${starsHTML("gl", ratingOf(f))}
            `;
      if (isSensitive({ name: f.name, path: svPath, tags: f.tags }, svCfg) && !revealSet.has(state.type, state.subfolder, f.name)) {
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
  function currentSelectionDirMatches() {
    const sel = parseAnnotated(widget.value);
    if (sel.type !== state.type)
      return false;
    if (state.type === "path") {
      return (sel.subfolder || "").replace(/\/+$/, "") === (state.absDir || "").replace(/\/+$/, "");
    }
    return (sel.subfolder || "") === (state.subfolder || "");
  }
  function commitSelection() {
    const value = state.type === "path" ? buildAnnotated("path", state.absDir, state.selectedName) : buildAnnotated(state.type, state.subfolder, state.selectedName);
    widget.value = value;
    node.setDirtyCanvas?.(true, true);
    updateSelectedFooter();
  }
  function updateSelectedFooter() {
    refs.selected.textContent = (typeof widget.value === "string" ? widget.value : "") || "(none)";
  }
  async function toggleSensitiveTag(f, btn) {
    const keyword = sensitiveKeyword(readSafeViewConfig());
    if (!keyword)
      return;
    const next = !hasSensitiveTag(f, keyword);
    const addr = {
      type: state.type,
      subfolder: state.subfolder,
      absDir: state.absDir,
      name: f.name
    };
    btn.disabled = true;
    try {
      f.tags = await postTag(TAG_URL, addr, keyword, next);
      renderGrid();
    } catch (e) {
      notify({
        severity: "warn",
        summary: next ? "Not marked" : "Not unmarked",
        detail: String(e?.message ?? e)
      });
      btn.disabled = false;
    }
  }
  function setStarRating(name, row, next) {
    const prev = Number(row.dataset.rating || "0");
    applyStars(row, next);
    const f = state.files.find((x) => x.name === name);
    if (f)
      f.rating = next;
    const addr = {
      type: state.type,
      subfolder: state.subfolder,
      absDir: state.absDir,
      name
    };
    postRating(RATING_URL, addr, next).then((confirmed) => {
      if (confirmed !== next) {
        applyStars(row, confirmed);
        if (f)
          f.rating = confirmed;
      }
    }).catch((e) => {
      warnRating(EXT_NAME, e);
      notify({
        severity: "warn",
        summary: "Rating not saved",
        detail: String(e?.message ?? e)
      });
      applyStars(row, prev);
      if (f)
        f.rating = prev;
    });
  }
  let disposeLazyThumbs = null;
  function installLazyThumbs(grid) {
    disposeLazyThumbs?.();
    disposeLazyThumbs = installLazyMedia(grid, { root: grid, rootMargin: "200px" });
  }
  renderControls();
  loadAndRender();
  updateSelectedFooter();
}

// src/image-picker.ts
import { app as app2 } from "/scripts/app.js";
var EXT_NAME2 = "comfyui-gallery-loader";
var LIST_URL2 = "/gallery_loader/list";
var FILE_URL = "/gallery_loader/file";
var BASE_URL = "/gallery_loader/base";
var RATING_URL2 = "/gallery_loader/rating";
var METADATA_URL = "/gallery_loader/metadata";
var STYLE_ID4 = "ip-style";
var DEBUG = (() => {
  try {
    return localStorage.getItem(`${EXT_NAME2}:debug`) === "1";
  } catch {
    return false;
  }
})();
function debug(...args) {
  if (DEBUG)
    console.debug(`[${EXT_NAME2}]`, ...args);
}
var SORT_STORAGE_KEY2 = "comfyui-gallery-loader:sort";
var scrollMemory = createScrollMemory();
var viewStore = createViewStore("comfyui-gallery-loader");
var PINS_URL = "/gallery_loader/pins";
var PINNED_TYPE = "pinned";
function pinKeyOf(p) {
  return `${p.kind ?? ""}:${p.type ?? ""}:${p.subfolder ?? ""}:${p.name ?? ""}`;
}
function pinLabel(p) {
  return `${p.type ?? ""}${p.subfolder ? `/${p.subfolder}` : ""}`;
}
function pinsOfResponse(data) {
  return Array.isArray(data.pins) ? data.pins : [];
}
async function fetchPins() {
  const r = await fetch(PINS_URL);
  const data = await r.json();
  if (!r.ok || !data?.ok)
    throw new Error(data?.error || `HTTP ${r.status}`);
  return pinsOfResponse(data);
}
async function postPinDelta(op, item) {
  const body = { op };
  if (item)
    body.item = item;
  const r = await fetch(PINS_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  let data = {};
  try {
    data = await r.json();
  } catch {}
  if (!r.ok || !data.ok)
    throw new Error(data.error || `HTTP ${r.status}`);
  return pinsOfResponse(data);
}
var LEGACY_PINS_STORAGE_KEY = "comfyui-gallery-loader:pins";
var legacyPinMigration = null;
async function runLegacyPinMigration() {
  let raw = null;
  try {
    raw = localStorage.getItem(LEGACY_PINS_STORAGE_KEY);
  } catch {
    return;
  }
  if (!raw)
    return;
  try {
    const arr = JSON.parse(raw);
    if (Array.isArray(arr)) {
      for (const p of arr) {
        const pin = p;
        if (typeof pin?.subfolder !== "string")
          continue;
        if (!SANDBOXED_TYPES.includes(pin.type))
          continue;
        await postPinDelta("add", {
          kind: "dir",
          type: pin.type,
          subfolder: pin.subfolder
        });
      }
    }
  } catch (e) {
    console.warn(`[${EXT_NAME2}] pin migration failed — will retry next load`, e);
    return;
  }
  try {
    localStorage.removeItem(LEGACY_PINS_STORAGE_KEY);
  } catch {}
}
function migrateLegacyPins() {
  legacyPinMigration ??= runLegacyPinMigration();
  return legacyPinMigration;
}
function loadSavedSort2() {
  try {
    const raw = localStorage.getItem(SORT_STORAGE_KEY2);
    if (!raw || !isValidSort(raw))
      return null;
    const [key, dir] = raw.split(":");
    return { key, dir };
  } catch (e) {
    console.warn(`[${EXT_NAME2}] could not read saved sort`, e);
    return null;
  }
}
function saveSort2(key, dir) {
  try {
    localStorage.setItem(SORT_STORAGE_KEY2, `${key}:${dir}`);
  } catch (e) {
    console.warn(`[${EXT_NAME2}] could not save sort`, e);
  }
}
var VHS_PATH_LOADERS = new Set([
  "VHS_LoadImagePath",
  "VHS_LoadImagesPath",
  "VHS_LoadVideoPath",
  "VHS_LoadVideoFFmpegPath"
]);
var VHS_VIDEO_EXTS = [".webm", ".mp4", ".mkv", ".gif", ".mov"];
var VHS_COMBO_LOADERS = new Map([
  [
    "VHS_LoadVideo",
    {
      widget: "video",
      mode: "file",
      extensions: VHS_VIDEO_EXTS,
      title: "Choose video",
      button: "\uD83D\uDCC1 Browse videos"
    }
  ],
  [
    "VHS_LoadVideoFFmpeg",
    {
      widget: "video",
      mode: "file",
      extensions: VHS_VIDEO_EXTS,
      title: "Choose video",
      button: "\uD83D\uDCC1 Browse videos"
    }
  ],
  [
    "VHS_LoadImages",
    { widget: "directory", mode: "directory", title: "Choose folder", button: "\uD83D\uDCC1 Browse folders" }
  ]
]);
var UPLOAD_FLAGS = ["image_upload", "video_upload"];
var MEDIA_OF_FLAG = {
  image_upload: "image",
  video_upload: "video"
};
var CORE_LOADERS = new Map([
  ["LoadImage", { widget: "image", media: "image" }],
  ["LoadImageMask", { widget: "image", media: "image" }],
  ["LoadImageOutput", { widget: "image", media: "image" }],
  ["LoadVideo", { widget: "file", media: "video" }]
]);
var BASE_PATHS = null;
async function fetchBasePaths() {
  if (BASE_PATHS)
    return BASE_PATHS;
  let resolved;
  try {
    const r = await fetch(BASE_URL);
    if (!r.ok)
      throw new Error(`HTTP ${r.status}`);
    const data = await r.json();
    if (!data.ok)
      throw new Error(data.error || "base paths fetch failed");
    resolved = data;
  } catch (e) {
    console.warn(`[${EXT_NAME2}] /gallery_loader/base failed`, e);
    resolved = { base_path: "/", input_dir: "", output_dir: "", temp_dir: "" };
  }
  BASE_PATHS = resolved;
  return resolved;
}
function uploadFlagOfEntry(entry) {
  const opts = Array.isArray(entry) && entry.length >= 2 ? entry[1] : entry && typeof entry === "object" && !Array.isArray(entry) ? entry : null;
  if (!opts || typeof opts !== "object")
    return null;
  const bag = opts;
  for (const flag of UPLOAD_FLAGS) {
    if (bag[flag] === true)
      return flag;
  }
  return null;
}
function defangNodeData(nodeData) {
  const inputs = nodeData?.input;
  if (!inputs)
    return false;
  let touched = false;
  for (const group of ["required", "optional"]) {
    const block = inputs[group];
    if (!block)
      continue;
    for (const [name, entry] of Object.entries(block)) {
      const flag = uploadFlagOfEntry(entry);
      if (!flag)
        continue;
      const opts = Array.isArray(entry) ? entry[1] : entry;
      opts[flag] = false;
      opts._origUploadFlag = flag;
      touched = true;
      debug(`defanged ${flag} on ${nodeData?.name}.${name}`);
    }
  }
  return touched;
}
function widgetNamed(node, name) {
  return node.widgets?.find((w) => w?.name === name) ?? null;
}
function findUploadWidget(node) {
  if (!node?.widgets)
    return null;
  for (const w2 of node.widgets) {
    const flag = w2?.options?._origUploadFlag;
    if (flag)
      return { w: w2, media: MEDIA_OF_FLAG[flag] };
  }
  const core = CORE_LOADERS.get(node.comfyClass || "") ?? CORE_LOADERS.get(node.type || "");
  if (!core)
    return null;
  const w = widgetNamed(node, core.widget);
  return w ? { w, media: core.media } : null;
}
function seedAnnotatedValue(w) {
  const v = (typeof w.value === "string" ? w.value : "").trim();
  if (!/\[(output|temp)\]\s*$/.test(v))
    return;
  const values = w.options?.values;
  if (Array.isArray(values) && !values.includes(v))
    values.push(v);
}
function addPickerHint(w) {
  const existing = w.options?.tooltip || "";
  const hint = "Click to open the gallery picker (or use the \uD83D\uDCC1 button below).";
  if (w.options) {
    w.options.tooltip = existing ? `${existing}

${hint}` : hint;
  }
}
function wireOpeners(node, w, buttonLabel, opts) {
  patchWidgetPointer(w, (_pointer, ownerNode) => {
    openImagePicker(w, ownerNode || node, opts);
    return true;
  });
  appendButtonWidget(node, buttonLabel, () => {
    openImagePicker(w, node, opts);
  }, { logPrefix: EXT_NAME2 });
}
function enhanceUploadComboNode(node) {
  if (!node?.widgets)
    return;
  if (node._galleryPickerEnhanced)
    return;
  const found = findUploadWidget(node);
  if (!found)
    return;
  const { w, media } = found;
  node._galleryPickerEnhanced = true;
  seedAnnotatedValue(w);
  debug(`enhancing ${node.comfyClass || node.type}:`, {
    widgetName: w.name,
    widgetType: w.type,
    media
  });
  addPickerHint(w);
  wireOpeners(node, w, media === "video" ? "\uD83D\uDCC1 Browse videos" : "\uD83D\uDCC1 Browse gallery", {
    kind: "loadimage",
    extensions: media === "video" ? [...VIDEO_EXTS] : undefined,
    title: media === "video" ? "Choose video" : "Choose image"
  });
}
function enhanceVHSComboNode(node) {
  if (!node?.widgets)
    return;
  if (node._vhsComboEnhanced)
    return;
  const spec = VHS_COMBO_LOADERS.get(node.comfyClass || "");
  if (!spec)
    return;
  const w = widgetNamed(node, spec.widget);
  if (!w)
    return;
  node._vhsComboEnhanced = true;
  seedAnnotatedValue(w);
  debug(`enhancing VHS combo ${node.comfyClass}:`, {
    widgetName: w.name,
    mode: spec.mode
  });
  addPickerHint(w);
  wireOpeners(node, w, spec.button, {
    kind: "loadimage",
    mode: spec.mode,
    extensions: spec.extensions,
    title: spec.title
  });
}
function findVHSPathWidget(node) {
  if (!node?.widgets)
    return null;
  for (const w of node.widgets) {
    if (Array.isArray(w?.options?.vhs_path_extensions))
      return w;
  }
  return null;
}
function enhanceVHSPathNode(node) {
  if (!node?.widgets)
    return;
  if (node._vhsGalleryEnhanced)
    return;
  if (!node.comfyClass || !VHS_PATH_LOADERS.has(node.comfyClass))
    return;
  const w = findVHSPathWidget(node);
  if (!w)
    return;
  node._vhsGalleryEnhanced = true;
  const exts = w.options?.vhs_path_extensions;
  const isDirectoryMode = Array.isArray(exts) && exts.length === 0;
  debug(`enhancing VHS ${node.comfyClass}:`, {
    widgetName: w.name,
    mode: isDirectoryMode ? "directory" : "file",
    exts
  });
  const label = isDirectoryMode ? "\uD83D\uDCC1 Browse folder" : "\uD83D\uDCC1 Browse files";
  appendButtonWidget(node, label, () => {
    openImagePicker(w, node, {
      kind: "vhs-path",
      mode: isDirectoryMode ? "directory" : "file",
      extensions: exts
    });
  }, { logPrefix: EXT_NAME2 });
}
function isAbsPath(v) {
  return v.startsWith("/") || /^[A-Za-z]:[\\/]/.test(v);
}
function parseLoadImageValue(v) {
  const s = (typeof v === "string" ? v : "").trim();
  if (!s)
    return { type: "input", subfolder: "", name: "" };
  const ann = s.match(/^(.*?)\s*\[(input|output|temp)\]\s*$/);
  if (ann) {
    const rel = ann[1].replace(/\\/g, "/");
    const idx2 = rel.lastIndexOf("/");
    return {
      type: ann[2],
      subfolder: idx2 >= 0 ? rel.slice(0, idx2) : "",
      name: idx2 >= 0 ? rel.slice(idx2 + 1) : rel
    };
  }
  const norm = s.replace(/\\/g, "/");
  const idx = norm.lastIndexOf("/");
  return {
    type: "input",
    subfolder: idx >= 0 ? norm.slice(0, idx) : "",
    name: idx >= 0 ? norm.slice(idx + 1) : norm
  };
}
function parseLoadImageDirValue(v) {
  const s = (typeof v === "string" ? v : "").trim();
  if (!s)
    return { type: "input", subfolder: "" };
  const ann = s.match(/^(.*?)\s*\[(input|output|temp)\]\s*$/);
  const rel = (ann ? ann[1] : s).replace(/\\/g, "/").replace(/^\.?\/*|\/+$/g, "");
  return { type: ann ? ann[2] : "input", subfolder: rel };
}
function parseAbsPath(v) {
  const s = (typeof v === "string" ? v : "").trim();
  if (!s || !isAbsPath(s))
    return { dir: "", name: "" };
  const norm = s.replace(/\\/g, "/");
  const idx = norm.lastIndexOf("/");
  return {
    dir: idx > 0 ? norm.slice(0, idx) : "/",
    name: idx >= 0 ? norm.slice(idx + 1) : ""
  };
}
function buildLoadImageValue(type, subfolder, name) {
  const sub = (subfolder || "").replace(/^\/+|\/+$/g, "");
  const rel = sub ? `${sub}/${name}` : name;
  return type === "input" ? rel : `${rel} [${type}]`;
}
function thumbVersion(f) {
  return `${f.mtime}-${f.size ?? 0}`;
}
function imageThumbURL(type, subfolder, f) {
  const p = new URLSearchParams({
    type,
    subfolder: subfolder || "",
    name: f.name,
    v: thumbVersion(f)
  });
  return `/gallery_loader/thumb?${p.toString()}`;
}
function imageThumbURLAbs(absDir, f) {
  const full = joinAbs(absDir, f.name);
  return `/gallery_loader/thumb?path=${encodeURIComponent(full)}&v=${encodeURIComponent(thumbVersion(f))}`;
}
function videoSrcURL(type, subfolder, name, absDir) {
  if (type === "path") {
    const full = joinAbs(absDir || "", name);
    return `${FILE_URL}?path=${encodeURIComponent(full)}`;
  }
  const p = new URLSearchParams({ filename: name, type, subfolder: subfolder || "" });
  return `/api/view?${p.toString()}`;
}
async function fetchMetadata(type, subfolder, name, absDir) {
  const p = new URLSearchParams;
  if (type === "path") {
    p.set("path", joinAbs(absDir, name));
  } else {
    p.set("type", type);
    p.set("subfolder", subfolder);
    p.set("name", name);
  }
  const r = await fetch(`${METADATA_URL}?${p.toString()}`);
  let data = {};
  try {
    data = await r.json();
  } catch {}
  if (!r.ok || !data.ok) {
    throw new Error(data.error || `HTTP ${r.status}`);
  }
  return {
    format: data.format || "",
    source: data.source || "none",
    summary: data.summary || {},
    raw: data.raw || {},
    truncated: !!data.truncated
  };
}
async function openImagePicker(widget, node, opts) {
  ensureStyleOnce(STYLE_ID4, PICKER_CSS);
  const kind = opts.kind;
  const mode = opts.mode || "file";
  const extensions = Array.isArray(opts.extensions) ? opts.extensions : null;
  const state = {
    kind,
    mode,
    type: "input",
    subfolder: "",
    absPath: "",
    currentName: "",
    dirs: [],
    files: [],
    sortKey: "mtime",
    sortDir: "desc",
    query: "",
    didInitialScroll: false,
    extensionsParam: null,
    viewMode: "folder"
  };
  const savedSort = loadSavedSort2();
  if (savedSort) {
    state.sortKey = savedSort.key;
    state.sortDir = savedSort.dir;
  }
  const savedView = viewStore.load();
  state.viewMode = savedView.mode;
  function isFlat() {
    return state.viewMode === "flat" && mode !== "directory" && SANDBOXED_TYPES.includes(state.type);
  }
  function fileSub(f) {
    const sp = f.subpath || "";
    if (!sp)
      return state.subfolder;
    const base = state.subfolder.replace(/\/+$/, "");
    return base ? `${base}/${sp}` : sp;
  }
  function fileType(f) {
    return f.pinType ?? state.type;
  }
  function isPinned() {
    return state.type === PINNED_TYPE;
  }
  let initialSnapshot;
  if (kind === "loadimage") {
    state.extensionsParam = mode === "directory" ? [".__none__"] : extensions?.length ? extensions.map((e) => e.startsWith(".") ? e : `.${e}`) : null;
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
    state.type = "path";
    state.extensionsParam = extensions?.length ? extensions.map((e) => e.startsWith(".") ? e : `.${e}`) : mode === "directory" ? [".__none__"] : null;
    const parsed = parseAbsPath(widget.value);
    if (parsed.dir) {
      state.absPath = mode === "directory" && parsed.name ? joinAbs(parsed.dir, parsed.name) : parsed.dir;
      state.currentName = parsed.name;
    } else {
      const bp = await fetchBasePaths();
      state.absPath = bp.base_path || "/";
    }
    initialSnapshot = { type: "path", subfolder: state.absPath, name: state.currentName };
  }
  const titleByKind = opts.title ?? (mode === "directory" ? "Choose folder" : kind === "loadimage" ? "Choose image" : "Choose file");
  const footerLeftHTML = mode === "directory" ? "<kbd>Esc</kbd> close · click a folder to descend · click <b>Use this folder</b> to commit" : "<kbd>Esc</kbd> close · click a card to select · click a folder to descend";
  const modal = openModalShell({
    title: titleByKind,
    subtitle: `(${widget.name})`,
    placeholder: "Filter by filename…",
    width: "min(1100px, calc(100vw - 16px))",
    height: "min(88vh, 820px)",
    footerLeftHTML,
    footerRightHTML: '<span class="ip-count"></span>',
    onClose: () => {
      rememberScroll();
      scroller.dispose();
      disposeBackGuard?.();
      disposeBackGuard = null;
      disposeSafeViewSub?.();
      disposeSafeViewSub = null;
      revealSet.clear();
    }
  });
  const scroller = installScrollRestore(modal.bodyEl);
  function rememberScroll() {
    scrollMemory.remember(locationKey(), scroller.current());
  }
  const revealSet = makeRevealSet();
  let disposeSafeViewSub = null;
  function safeViewPath(f) {
    if (state.type === "path")
      return state.absPath || "";
    const sub = fileSub(f);
    const root = fileType(f);
    return sub ? `${root}/${sub}` : root;
  }
  function isHiddenCard(f, cfg) {
    if (!isSensitive({ name: f.name, path: safeViewPath(f), tags: f.tags }, cfg))
      return false;
    return !revealSet.has(fileType(f), fileSub(f), f.name);
  }
  function safeViewMediaEl(card) {
    return card.querySelector(".ip-thumb img, .ip-thumb video, .ip-thumb > .ip-thumb-icon");
  }
  function applySafeView(card, cfg, onReveal) {
    card.classList.add("is-safe-hidden");
    const media = safeViewMediaEl(card);
    if (media)
      setBlurred(media, true);
    if (cfg.blurNames) {
      for (const el of card.querySelectorAll(".ip-name, .ip-subpath"))
        setSpoilered(el, true);
    }
    const host = card.querySelector(".ip-thumb") ?? card;
    host.appendChild(makeRevealButton({ onReveal }));
  }
  let disposeBackGuard = null;
  function canGoUp() {
    return state.type === "path" ? !!state.absPath && state.absPath !== "/" : !!state.subfolder;
  }
  disposeBackGuard = installBackGuard(() => {
    if (modal.dialog.querySelector(".cmp-ov-backdrop")) {
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
  let tabsEl = null;
  if (kind === "loadimage") {
    tabsEl = document.createElement("div");
    tabsEl.className = "ip-tabs";
    const tabTypes = mode === "directory" ? [...SANDBOXED_TYPES] : [...SANDBOXED_TYPES, PINNED_TYPE];
    for (const t of tabTypes) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "ip-tab";
      b.dataset.type = t;
      b.textContent = t === PINNED_TYPE ? "\uD83D\uDCCC pinned" : t;
      tabsEl.appendChild(b);
    }
    modal.toolbarEl.appendChild(tabsEl);
  }
  const crumbsEl = document.createElement("div");
  crumbsEl.className = "ip-crumbs";
  const sortEl = document.createElement("select");
  sortEl.className = "ip-control";
  sortEl.title = "Sort";
  sortEl.innerHTML = SORT_OPTIONS.map((o) => `<option value="${o.value}">${escapeHTML(o.label)}</option>`).join("");
  sortEl.value = `${state.sortKey}:${state.sortDir}`;
  const refreshEl = document.createElement("button");
  refreshEl.type = "button";
  refreshEl.className = "ip-control ip-icon";
  refreshEl.title = "Refresh";
  refreshEl.textContent = "⟳";
  let viewToggleEl = null;
  if (kind === "loadimage" && mode !== "directory") {
    viewToggleEl = document.createElement("button");
    viewToggleEl.type = "button";
    viewToggleEl.className = "ip-control ip-icon ip-view-toggle";
    viewToggleEl.title = "Flat view (all subfolders)";
    viewToggleEl.textContent = "≣";
  }
  let pinToggleEl = null;
  let pinsEl = null;
  let pruneEl = null;
  if (kind === "loadimage") {
    pinToggleEl = document.createElement("button");
    pinToggleEl.type = "button";
    pinToggleEl.className = "ip-control ip-icon ip-pin-toggle";
    pinToggleEl.title = "Pin this folder";
    pinToggleEl.textContent = "\uD83D\uDCCC";
    pruneEl = document.createElement("button");
    pruneEl.type = "button";
    pruneEl.className = "ip-control ip-prune";
    pruneEl.title = "Drop every pin that no longer resolves";
    pruneEl.textContent = "Prune missing";
    pruneEl.style.display = "none";
    pinsEl = document.createElement("div");
    pinsEl.className = "ip-pins";
  }
  const safeViewEl = document.createElement("button");
  safeViewEl.type = "button";
  safeViewEl.className = "ip-control ip-icon ip-safe-view";
  function renderSafeViewToggle() {
    const on = isSafeViewActive();
    safeViewEl.textContent = on ? SAFE_VIEW_GLYPH_ON : SAFE_VIEW_GLYPH_OFF;
    safeViewEl.classList.toggle("is-active", on);
    safeViewEl.title = on ? "Safe View on — matching thumbnails are blurred. Tap to show everything." : "Safe View off — tap to blur thumbnails matching your keywords.";
    safeViewEl.setAttribute("aria-pressed", String(on));
  }
  renderSafeViewToggle();
  safeViewEl.addEventListener("click", () => {
    toggleSafeView();
  });
  modal.toolbarEl.append(crumbsEl, ...viewToggleEl ? [viewToggleEl] : [], ...pinToggleEl ? [pinToggleEl] : [], ...pruneEl ? [pruneEl] : [], safeViewEl, sortEl, refreshEl, ...pinsEl ? [pinsEl] : []);
  let pinEntries = [];
  let pinKeys = new Set;
  function adoptPins(entries) {
    pinEntries = entries;
    pinKeys = new Set(entries.map(pinKeyOf));
  }
  async function refreshPins() {
    try {
      await migrateLegacyPins();
      adoptPins(await fetchPins());
    } catch (e) {
      console.warn(`[${EXT_NAME2}] pin list unavailable`, e);
      adoptPins([]);
    }
  }
  async function applyPinDelta(op, item) {
    try {
      adoptPins(await postPinDelta(op, item));
    } catch (e) {
      console.warn(`[${EXT_NAME2}] pin ${op} failed`, e);
      notify({
        severity: "warn",
        summary: op === "remove" ? "Pin not removed" : "Pin not saved",
        detail: String(e?.message ?? e)
      });
      return false;
    }
    renderPins();
    return true;
  }
  function filePinItem(f) {
    return { kind: "file", type: fileType(f), subfolder: fileSub(f), name: f.name };
  }
  function isFilePinned(f) {
    return pinKeys.has(pinKeyOf(filePinItem(f)));
  }
  async function toggleFilePin(f, btn) {
    const item = filePinItem(f);
    if (!await applyPinDelta(pinKeys.has(pinKeyOf(item)) ? "remove" : "add", item))
      return;
    if (isPinned()) {
      applyPinnedListing();
      renderGrid();
      return;
    }
    const nowPinned = pinKeys.has(pinKeyOf(item));
    btn.classList.toggle("is-pinned", nowPinned);
    btn.title = nowPinned ? "Unpin this file" : "Pin this file";
    btn.setAttribute("aria-pressed", String(nowPinned));
  }
  function renderPins() {
    if (!pinToggleEl || !pinsEl)
      return;
    const dirs = pinEntries.filter((p) => p.kind === "dir" && SANDBOXED_TYPES.includes(p.type ?? ""));
    const canPin = SANDBOXED_TYPES.includes(state.type);
    pinToggleEl.style.display = canPin ? "" : "none";
    const herePinned = canPin && pinKeys.has(pinKeyOf({ kind: "dir", type: state.type, subfolder: state.subfolder }));
    pinToggleEl.classList.toggle("is-active", herePinned);
    pinToggleEl.title = herePinned ? "Unpin this folder" : "Pin this folder";
    if (pruneEl) {
      const anyMissing = pinEntries.some((p) => p.exists === false);
      pruneEl.style.display = isPinned() && anyMissing ? "" : "none";
    }
    pinsEl.innerHTML = "";
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
      go.textContent = `\uD83D\uDCCC ${pinLabel(p)}`;
      const x = document.createElement("button");
      x.type = "button";
      x.className = "ip-pin-x";
      x.title = `Unpin ${pinLabel(p)}`;
      x.textContent = "✕";
      chip.append(go, x);
      pinsEl.appendChild(chip);
    }
  }
  function renderViewToggle() {
    if (!viewToggleEl)
      return;
    const ok = SANDBOXED_TYPES.includes(state.type);
    viewToggleEl.style.display = ok ? "" : "none";
    viewToggleEl.classList.toggle("is-active", isFlat());
    viewToggleEl.title = isFlat() ? "Folder view" : "Flat view (all subfolders)";
  }
  const gridEl = document.createElement("div");
  gridEl.className = "ip-grid";
  modal.bodyEl.appendChild(gridEl);
  let renderedFiles = [];
  function fileOfCard(card) {
    const idx = Number(card.dataset.idx);
    return Number.isInteger(idx) ? renderedFiles[idx] ?? null : null;
  }
  const countEl = modal.footerEl.querySelector(".ip-count");
  function setCount(visible, total) {
    if (!countEl)
      return;
    countEl.textContent = `${visible} / ${total}`;
  }
  let useFolderEl = null;
  if (mode === "directory") {
    useFolderEl = document.createElement("button");
    useFolderEl.type = "button";
    useFolderEl.className = "ip-use-folder";
    useFolderEl.textContent = "Use this folder";
    const rightCell = modal.footerEl.lastElementChild;
    if (rightCell) {
      rightCell.appendChild(useFolderEl);
    }
    useFolderEl.addEventListener("click", () => commitFolder());
  }
  modal.searchEl.addEventListener("input", () => {
    state.query = modal.searchEl.value.toLowerCase().trim();
    renderGrid({ scrollTo: 0 });
  });
  sortEl.addEventListener("change", () => {
    const [k, d] = sortEl.value.split(":");
    state.sortKey = k;
    state.sortDir = d;
    saveSort2(k, d);
    renderGrid({ scrollTo: 0 });
  });
  refreshEl.addEventListener("click", () => loadAndRender({ preserveScroll: true }));
  pinToggleEl?.addEventListener("click", () => {
    if (!SANDBOXED_TYPES.includes(state.type))
      return;
    const item = { kind: "dir", type: state.type, subfolder: state.subfolder };
    applyPinDelta(pinKeys.has(pinKeyOf(item)) ? "remove" : "add", item);
  });
  pinsEl?.addEventListener("click", (e) => {
    const t = e.target;
    const chip = t.closest("[data-pin-type]");
    if (!chip)
      return;
    const type = chip.dataset.pinType;
    if (!SANDBOXED_TYPES.includes(type))
      return;
    const item = { kind: "dir", type, subfolder: chip.dataset.pinSub || "" };
    if (t.closest(".ip-pin-x")) {
      applyPinDelta("remove", item);
      return;
    }
    if (item.type === state.type && item.subfolder === state.subfolder)
      return;
    rememberScroll();
    state.type = item.type;
    state.subfolder = item.subfolder;
    loadAndRender();
  });
  pruneEl?.addEventListener("click", () => {
    applyPinDelta("prune").then((ok) => {
      if (ok && isPinned()) {
        applyPinnedListing();
        renderGrid();
      }
    });
  });
  viewToggleEl?.addEventListener("click", () => {
    if (!SANDBOXED_TYPES.includes(state.type))
      return;
    rememberScroll();
    state.viewMode = state.viewMode === "flat" ? "folder" : "flat";
    viewStore.save(state.viewMode);
    loadAndRender();
  });
  if (tabsEl) {
    tabsEl.addEventListener("click", (e) => {
      const b = e.target.closest("[data-type]");
      if (!b)
        return;
      if (state.type === b.dataset.type)
        return;
      rememberScroll();
      state.type = b.dataset.type;
      state.subfolder = "";
      loadAndRender();
    });
  }
  crumbsEl.addEventListener("click", (e) => {
    const c = e.target.closest("[data-sub], [data-abs]");
    if (!c)
      return;
    rememberScroll();
    if (c.dataset.abs !== undefined) {
      state.absPath = c.dataset.abs || "/";
    } else {
      state.subfolder = c.dataset.sub || "";
    }
    loadAndRender();
  });
  gridEl.addEventListener("click", (e) => {
    const star = e.target.closest(".ip-star");
    if (!star)
      return;
    e.stopPropagation();
    const card = star.closest(".ip-card");
    const row = star.parentElement;
    if (!card || !row)
      return;
    const f = fileOfCard(card);
    if (!f)
      return;
    const cur = Number(row.dataset.rating || "0");
    setStarRating(f, row, nextRating(cur, Number(star.dataset.val)));
  });
  gridEl.addEventListener("click", (e) => {
    const btn = e.target.closest(".ip-pin-file");
    if (!btn)
      return;
    e.stopPropagation();
    const card = btn.closest(".ip-card");
    if (!card)
      return;
    const f = fileOfCard(card);
    if (!f)
      return;
    toggleFilePin(f, btn);
  });
  gridEl.addEventListener("click", (e) => {
    const btn = e.target.closest(".ip-mark-sensitive");
    if (!btn)
      return;
    e.stopPropagation();
    const card = btn.closest(".ip-card");
    if (!card)
      return;
    const f = fileOfCard(card);
    if (!f)
      return;
    toggleSensitiveTag(f, btn);
  });
  gridEl.addEventListener("click", (e) => {
    const target = e.target;
    if (target.closest(".ip-star") || target.closest(".ip-pin-file") || target.closest(".ip-mark-sensitive"))
      return;
    const card = target.closest(".ip-card");
    if (!card)
      return;
    if (card.classList.contains("is-up")) {
      navigateUp();
      return;
    }
    if (card.classList.contains("is-dir")) {
      navigateInto(card.dataset.name);
      return;
    }
    if (card.classList.contains("is-file")) {
      if (mode === "directory")
        return;
      if (target.closest(".ip-info")) {
        e.stopPropagation();
        const info = fileOfCard(card);
        if (info)
          openMetadata(info);
        return;
      }
      const subEl = target.closest(".ip-subpath");
      if (subEl?.dataset.sub !== undefined) {
        e.stopPropagation();
        rememberScroll();
        state.viewMode = "folder";
        viewStore.save("folder");
        if (subEl.dataset.pinType)
          state.type = subEl.dataset.pinType;
        state.subfolder = subEl.dataset.sub || "";
        loadAndRender();
        return;
      }
      const f = fileOfCard(card);
      if (!f)
        return;
      if (f.pinExists === false) {
        notify({
          severity: "warn",
          summary: "That file is gone",
          detail: `${fileType(f)}/${fileSub(f) ? `${fileSub(f)}/` : ""}${f.name} no longer resolves. Unpin it with \uD83D\uDCCC, or use "Prune missing".`
        });
        return;
      }
      commitFile(f);
    }
  });
  const copyFeedback = new WeakMap;
  function copyInto(btn, text, restore) {
    let fb = copyFeedback.get(btn);
    if (!fb) {
      fb = { seq: 0, timer: null };
      copyFeedback.set(btn, fb);
    }
    const slot = fb;
    const seq = ++slot.seq;
    if (slot.timer !== null) {
      clearTimeout(slot.timer);
      slot.timer = null;
    }
    copyTextToClipboard(text).then((ok) => {
      if (slot.seq !== seq)
        return;
      btn.textContent = ok ? "Copied ✓" : "Copy failed";
      btn.classList.toggle("is-copied", ok);
      slot.timer = setTimeout(() => {
        slot.timer = null;
        btn.textContent = restore;
        btn.classList.remove("is-copied");
      }, 1500);
    });
  }
  async function openMetadata(f) {
    let live = true;
    const ov = openShellOverlay(modal, {
      onDismiss: () => {
        live = false;
      }
    });
    ov.card.classList.add("ip-meta-card");
    const close = () => {
      live = false;
      ov.close();
    };
    const title = `Metadata — ${escapeHTML(f.name)}`;
    ov.card.innerHTML = `
      <div class="cmp-ov-title">${title}</div>
      <div class="ip-meta-body"><div class="ip-meta-status">Reading metadata…</div></div>
      <div class="cmp-ov-actions">
        <button type="button" class="cmp-ov-btn" data-meta-close>Close</button>
      </div>`;
    ov.card.querySelector("[data-meta-close]")?.addEventListener("click", close);
    let data;
    try {
      data = await fetchMetadata(fileType(f), fileSub(f), f.name, state.absPath);
    } catch (e) {
      close();
      console.error(`[${EXT_NAME2}] metadata read failed:`, e);
      notify({
        severity: "error",
        summary: "Metadata read failed",
        detail: String(e?.message ?? e)
      });
      return;
    }
    if (!live)
      return;
    const rows = metaRows(data.summary);
    const rawKeys = Object.keys(data.raw);
    const srcLabel = data.source === "comfyui" ? "ComfyUI" : data.source === "a1111" ? "A1111" : "no generation data";
    const rowsHTML = rows.map((r, i) => `
        <div class="ip-meta-row">
          <div class="ip-meta-k">${escapeHTML(r.label)}</div>
          <div class="ip-meta-v">${escapeHTML(r.value)}</div>
          <button type="button" class="ip-meta-copy" data-copy-row="${i}">Copy</button>
        </div>`).join("");
    const emptyHTML = rows.length ? "" : `<div class="ip-meta-empty">${rawKeys.length ? "No recognised generation parameters." : "No generation metadata found."}</div>`;
    const rawJSON = JSON.stringify(data.raw, null, 2);
    const rawHTML = rawKeys.length ? `
        <details class="ip-meta-raw">
          <summary>Raw metadata (${rawKeys.length} key${rawKeys.length === 1 ? "" : "s"})</summary>
          <pre>${escapeHTML(rawJSON)}</pre>
          <button type="button" class="ip-meta-copy" data-copy-raw>Copy JSON</button>
        </details>` : "";
    const noteHTML = data.truncated ? `<div class="ip-meta-note">Some values were truncated by the server.</div>` : "";
    const copyAll = rows.length ? `<button type="button" class="cmp-ov-btn cmp-ov-primary" data-copy-all>Copy all</button>` : "";
    ov.card.innerHTML = `
      <div class="cmp-ov-title">${title}</div>
      <div class="ip-meta-body">
        <div class="ip-meta-src">${escapeHTML(srcLabel)}${data.format ? `<span class="ip-meta-fmt">${escapeHTML(data.format)}</span>` : ""}</div>
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
    for (const btn of ov.card.querySelectorAll("[data-copy-row]")) {
      const row = rows[Number(btn.dataset.copyRow)];
      const label = btn.textContent || "Copy";
      if (row)
        btn.addEventListener("click", () => copyInto(btn, row.value, label));
    }
    const rawBtn = ov.card.querySelector("[data-copy-raw]");
    const rawLabel = rawBtn?.textContent || "Copy JSON";
    rawBtn?.addEventListener("click", () => copyInto(rawBtn, rawJSON, rawLabel));
    const allBtn = ov.card.querySelector("[data-copy-all]");
    const allLabel = allBtn?.textContent || "Copy all";
    allBtn?.addEventListener("click", () => copyInto(allBtn, metaClipboardText(rows), allLabel));
  }
  function addressOf(f) {
    return {
      type: fileType(f),
      subfolder: fileSub(f),
      absDir: state.absPath,
      name: f.name
    };
  }
  function setStarRating(f, row, next) {
    const prev = Number(row.dataset.rating || "0");
    applyStars(row, next);
    f.rating = next;
    postRating(RATING_URL2, addressOf(f), next).then((confirmed) => {
      if (confirmed !== next) {
        applyStars(row, confirmed);
        f.rating = confirmed;
      }
    }).catch((e) => {
      warnRating(EXT_NAME2, e);
      notify({
        severity: "warn",
        summary: "Rating not saved",
        detail: String(e?.message ?? e)
      });
      applyStars(row, prev);
      f.rating = prev;
    });
  }
  async function toggleSensitiveTag(f, btn) {
    const cfg = readSafeViewConfig();
    const keyword = sensitiveKeyword(cfg);
    if (!keyword)
      return;
    const next = !hasSensitiveTag(f, keyword);
    btn.disabled = true;
    try {
      f.tags = await postTag(TAG_URL, addressOf(f), keyword, next);
      renderGrid();
    } catch (e) {
      notify({
        severity: "warn",
        summary: next ? "Not marked" : "Not unmarked",
        detail: String(e?.message ?? e)
      });
      btn.disabled = false;
    }
  }
  function navigateUp() {
    rememberScroll();
    if (state.type === "path") {
      const p = (state.absPath || "/").replace(/\/+$/, "");
      if (p === "" || p === "/")
        return;
      const i = p.lastIndexOf("/");
      state.absPath = i <= 0 ? "/" : p.slice(0, i);
    } else {
      const p = state.subfolder.replace(/\/+$/, "");
      const i = p.lastIndexOf("/");
      state.subfolder = i <= 0 ? "" : p.slice(0, i);
    }
    loadAndRender();
  }
  function navigateInto(name) {
    rememberScroll();
    if (state.type === "path") {
      state.absPath = joinAbs(state.absPath, name);
    } else {
      const base = state.subfolder.replace(/\/+$/, "");
      state.subfolder = base ? `${base}/${name}` : name;
    }
    loadAndRender();
  }
  function renderTabs() {
    if (!tabsEl)
      return;
    for (const b of tabsEl.querySelectorAll(".ip-tab")) {
      b.classList.toggle("is-active", b.dataset.type === state.type);
    }
  }
  function renderCrumbs() {
    crumbsEl.innerHTML = "";
    const mk = (text, attr, value) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "ip-crumb";
      b.setAttribute(attr, value);
      b.textContent = text;
      return b;
    };
    if (state.type === "path") {
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
  function buildListingURL() {
    const p = new URLSearchParams;
    if (state.type === "path") {
      p.set("type", "path");
      p.set("path", state.absPath || "/");
    } else {
      p.set("type", state.type);
      p.set("subfolder", state.subfolder);
      if (isFlat())
        p.set("recursive", "1");
    }
    if (state.extensionsParam?.length) {
      p.set("extensions", state.extensionsParam.join(","));
    }
    const kw = safeHideKeywords();
    if (kw) {
      p.set("safe_kw", kw);
      p.set("safe_hide", "1");
    }
    return `${LIST_URL2}?${p.toString()}`;
  }
  function safeHideKeywords() {
    const cfg = readSafeViewConfig();
    return cfg.hide && isSafeViewActive(cfg) ? cfg.keywords.join(",") : "";
  }
  function numOr0(v) {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  }
  function pinToListingFile(p) {
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
      subpath: p.subfolder ?? "",
      pinType: p.type ?? "",
      pinExists: p.exists !== false
    };
  }
  function applyPinnedListing() {
    state.dirs = [];
    state.files = pinEntries.filter((p) => p.kind === "file").map(pinToListingFile);
    modal.setStatus("");
  }
  let revealLocation = null;
  let lastSafeHideKeywords = safeHideKeywords();
  function locationKey() {
    return state.type === "path" ? `path:${state.absPath}` : `${state.type}:${state.subfolder}:${isFlat() ? "flat" : "folder"}`;
  }
  disposeSafeViewSub = onSafeViewChange(() => {
    renderSafeViewToggle();
    const kw = safeHideKeywords();
    if (kw !== lastSafeHideKeywords) {
      loadAndRender({ preserveScroll: true });
      return;
    }
    renderGrid();
  });
  async function loadAndRender(opts2) {
    lastSafeHideKeywords = safeHideKeywords();
    const here = locationKey();
    if (revealLocation !== null && revealLocation !== here)
      revealSet.clear();
    revealLocation = here;
    renderTabs();
    renderCrumbs();
    renderViewToggle();
    renderPins();
    modal.setBusy(true);
    modal.setStatus("Loading…");
    viewStore.markPending(isFlat());
    const pinsDone = refreshPins();
    if (isPinned()) {
      await pinsDone;
      applyPinnedListing();
    } else {
      try {
        const r = await fetch(buildListingURL());
        if (!r.ok)
          throw new Error(`HTTP ${r.status}`);
        const data = await r.json();
        if (!data.ok)
          throw new Error(data.error || "listing failed");
        state.dirs = data.dirs || [];
        state.files = data.files || [];
        modal.setStatus(data.exists ? "" : "Directory not found.");
        if (data.truncated) {
          notify({
            severity: "warn",
            summary: `Showing the newest ${state.files.length}`,
            detail: "This folder has more files than the listing returns; older ones are not shown."
          });
        }
      } catch (e) {
        console.error(`[${EXT_NAME2}] list failed:`, e);
        modal.setStatus(`Error: ${e.message}`);
        state.dirs = [];
        state.files = [];
      }
      await pinsDone;
    }
    modal.setBusy(false);
    renderPins();
    renderGrid({
      scrollTo: opts2?.preserveScroll ? undefined : scrollMemory.get(locationKey())
    });
    viewStore.markPending(false);
  }
  function thumbForFile(f) {
    const ext = (f.ext || "").toLowerCase();
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
      return { kind: "icon", text: "\uD83D\uDCC4" };
    }
    const sub = fileSub(f);
    if (IMG_EXTS.has(ext)) {
      return { kind: "img", src: imageThumbURL(type, sub, f) };
    }
    if (VIDEO_EXTS.has(ext)) {
      return { kind: "video", src: videoSrcURL(type, sub, f.name) };
    }
    return { kind: "icon", text: "\uD83D\uDCC4" };
  }
  function renderGrid(opts2) {
    const q = state.query;
    const targetScrollTop = opts2?.scrollTo ?? scroller.current();
    gridEl.innerHTML = "";
    const svCfg = readSafeViewConfig();
    const safeKeyword = sensitiveKeyword(svCfg);
    const flat = isFlat();
    const pinnedView = isPinned();
    const showUp = !flat && (state.type === "path" ? state.absPath && state.absPath !== "/" : !!state.subfolder);
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
      if (q && !d.name.toLowerCase().includes(q))
        continue;
      const c = document.createElement("div");
      c.className = "ip-card is-dir";
      c.dataset.name = d.name;
      c.innerHTML = `
                <div class="ip-thumb ip-thumb-icon">\uD83D\uDCC1</div>
                <div class="ip-name" title="${escapeHTML(d.name)}">${escapeHTML(d.name)}</div>
            `;
      if (isSensitive({ name: d.name }, svCfg) && !revealSet.has(state.type, state.subfolder, d.name)) {
        applySafeView(c, svCfg, () => {
          revealSet.reveal(state.type, state.subfolder, d.name);
          renderGrid();
        });
      }
      gridEl.appendChild(c);
    }
    let files = state.files;
    const nameMatches = new Map;
    if (q) {
      const scored = [];
      for (const f of files) {
        const prefix = flat && f.subpath ? `${f.subpath}/` : "";
        const r = fuzzyScore(q, `${prefix}${f.name}`);
        if (!r)
          continue;
        scored.push({ f, score: r.score });
        const off = prefix.length;
        nameMatches.set(f, r.matches.map((i) => i - off).filter((i) => i >= 0));
      }
      scored.sort((a, b) => b.score - a.score);
      files = scored.map((x) => x.f);
    } else {
      files = sortFiles(files, state.sortKey, state.sortDir);
    }
    renderedFiles = files;
    let visible = 0;
    const inSameLocation = state.type === "path" ? state.absPath === initialSnapshot.subfolder : state.type === initialSnapshot.type && state.subfolder === initialSnapshot.subfolder;
    for (const [i, f] of files.entries()) {
      const c = document.createElement("div");
      c.className = "ip-card is-file";
      c.dataset.idx = String(i);
      c.dataset.name = f.name;
      c.dataset.ext = (f.ext || "").toLowerCase();
      const selected = flat || pinnedView ? fileType(f) === initialSnapshot.type && fileSub(f) === initialSnapshot.subfolder && f.name === initialSnapshot.name : inSameLocation && f.name === initialSnapshot.name;
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
      const titleText = dims ? `${f.name}
${dims}
${when}` : `${f.name}
${when}`;
      const thumbInner = t.kind === "img" ? `<img loading="lazy" decoding="async" data-src="${t.src}" alt="">` : t.kind === "video" ? `<video muted playsinline preload="none" data-src="${t.src}"></video>` : `<div class="ip-thumb-icon">${t.text}</div>`;
      const stars = mode === "directory" || missing ? "" : starsHTML("ip", ratingOf(f));
      const pinned = isFilePinned(f);
      const pinBtn = mode !== "directory" && SANDBOXED_TYPES.includes(fileType(f)) ? `<button type="button" class="ip-pin-file${pinned ? " is-pinned" : ""}" aria-pressed="${pinned}" title="${pinned ? "Unpin this file" : "Pin this file"}">\uD83D\uDCCC</button>` : "";
      const infoBtn = mode !== "directory" && !missing && IMG_EXTS.has((f.ext || "").toLowerCase()) ? `<button type="button" class="ip-info" title="Generation metadata">ⓘ</button>` : "";
      const markBtn = mode !== "directory" && !missing && safeKeyword ? markSensitiveHTML("ip", safeKeyword, hasSensitiveTag(f, safeKeyword)) : "";
      const subLabel = pinnedView ? (() => {
        const ft = fileType(f);
        const sub = fileSub(f);
        const label = sub ? `${ft}/${sub}` : `${ft}/`;
        return `<button type="button" class="ip-subpath" data-sub="${escapeHTML(sub)}" data-pin-type="${escapeHTML(ft)}" title="Go to ${escapeHTML(label)}">${escapeHTML(label)}</button>`;
      })() : flat ? f.subpath ? `<button type="button" class="ip-subpath" data-sub="${escapeHTML(fileSub(f))}" title="Go to ${escapeHTML(f.subpath)}">${escapeHTML(f.subpath)}</button>` : `<div class="ip-subpath is-root" title="Top level">/</div>` : "";
      c.innerHTML = `
                ${subLabel}
                <div class="ip-thumb">${thumbInner}${infoBtn}${pinBtn}${markBtn}</div>
                <div class="ip-name" title="${escapeHTML(titleText)}">${escapeHTML(f.name)}</div>
                ${dims ? `<div class="ip-meta">${dims}</div>` : ""}
                ${stars}
            `;
      const hits = nameMatches.get(f);
      if (hits?.length) {
        const nameEl = c.querySelector(".ip-name");
        if (nameEl) {
          nameEl.textContent = "";
          nameEl.appendChild(highlightMatches(f.name, hits));
        }
      }
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
      el.textContent = mode === "directory" ? "No subfolders here." : pinnedView ? "Nothing pinned yet — tap \uD83D\uDCCC on a card to pin it." : "No matching files in this directory.";
      gridEl.appendChild(el);
    }
    if (useFolderEl) {
      useFolderEl.textContent = state.type === "path" ? `Use ${shortenPath(state.absPath)}` : `Use ${state.type}${state.subfolder ? `/${state.subfolder}` : ""}`;
    }
    setCount(visible, state.files.length);
    let target = targetScrollTop;
    if (!state.didInitialScroll) {
      state.didInitialScroll = true;
      if (target <= 0)
        target = selectedCentreOffset() ?? target;
    }
    scroller.restore(target);
    installLazyThumbs(gridEl);
  }
  function selectedCentreOffset() {
    const card = gridEl.querySelector(".ip-card.is-selected");
    if (!card)
      return null;
    const body = modal.bodyEl;
    return Math.max(0, card.offsetTop - Math.max(0, (body.clientHeight - card.offsetHeight) / 2));
  }
  function shortenPath(p) {
    if (!p)
      return "/";
    if (p.length <= 48)
      return p;
    return `…${p.slice(-46)}`;
  }
  let disposeLazyThumbs = null;
  function installLazyThumbs(rootEl) {
    disposeLazyThumbs?.();
    disposeLazyThumbs = installLazyMedia(rootEl, { root: modal.bodyEl, rootMargin: "300px" });
  }
  function commitFile(f) {
    let value;
    const type = fileType(f);
    if (type === "path") {
      value = joinAbs(state.absPath, f.name);
    } else {
      value = buildLoadImageValue(type, fileSub(f), f.name);
      const values = widget.options?.values;
      if (Array.isArray(values) && !values.includes(value)) {
        values.push(value);
      }
    }
    applyValue(value);
    modal.close();
  }
  function commitFolder() {
    if (state.type === "path") {
      applyValue(state.absPath || "/");
      modal.close();
      return;
    }
    const value = buildLoadImageValue(state.type, "", state.subfolder || ".");
    const values = widget.options?.values;
    if (Array.isArray(values) && !values.includes(value)) {
      values.push(value);
    }
    applyValue(value);
    modal.close();
  }
  function applyValue(value) {
    widget.value = value;
    if (widget.inputEl && typeof widget.inputEl.value === "string") {
      widget.inputEl.value = value;
    }
    try {
      widget.callback?.call(widget, value, app2.canvas, node);
    } catch (e) {
      console.warn(`[${EXT_NAME2}] widget callback threw`, e);
    }
    node?.setDirtyCanvas?.(true, true);
    app2.graph?.setDirtyCanvas?.(true, true);
  }
  loadAndRender();
  if (savedView.recovered) {
    notify({
      severity: "warn",
      summary: "Reopened in folder view",
      detail: "The last flat-view load didn't finish, so the picker fell back to folder view."
    });
  }
}
var PICKER_CSS = `
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
/* \uD83D\uDCCC file-pin toggle, mirroring ⓘ in the thumbnail's other corner. */
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
/* \uD83D\uDE48 mark-sensitive toggle. Bottom-RIGHT: ⓘ has top-right, \uD83D\uDCCC top-left, and
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
   handler refuses it and points at \uD83D\uDCCC / "Prune missing" instead. Asserted
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
function enhanceNode(node) {
  enhanceUploadComboNode(node);
  enhanceVHSComboNode(node);
  enhanceVHSPathNode(node);
}
try {
  app2.registerExtension({
    name: "comfy.gallery-loader.image-picker",
    settings: safeViewSettings(),
    async beforeRegisterNodeDef(_nodeType, nodeData) {
      try {
        defangNodeData(nodeData);
      } catch (e) {
        console.warn(`[${EXT_NAME2}] defang failed for ${nodeData?.name}`, e);
      }
    },
    setup() {
      ensureStyleOnce(STYLE_ID4, PICKER_CSS);
      registerSafeViewHubToggle();
      debug("image-picker setup running");
      const nodes = app2?.graph?._nodes;
      if (Array.isArray(nodes)) {
        for (const n of nodes)
          enhanceNode(n);
      }
    },
    nodeCreated(node) {
      enhanceNode(node);
    },
    loadedGraphNode(node) {
      enhanceNode(node);
    }
  });
} catch (e) {
  console.error(`[${EXT_NAME2}] image-picker.js: registerExtension threw`, e);
}
export {
  openImagePicker
};
