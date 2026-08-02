/* web/dist bundle built by bun from src/ in this repository (see package.json). Inlines @laurigates/comfy-modal-kit (MIT) - a first-party library by the same publisher, published to npm with provenance attestation: https://www.npmjs.com/package/@laurigates/comfy-modal-kit */

// node_modules/@laurigates/comfy-modal-kit/dist/index.js
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
      pointerGuardInstalled: false
    };
    g[KEY] = kit;
  }
  if (!kit.fieldProviders)
    kit.fieldProviders = [];
  if (!kit.modelPickers)
    kit.modelPickers = [];
  if (!kit.modalChrome)
    kit.modalChrome = [];
  return kit;
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
    width: 36px;
    height: 36px;
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
  const controller = {
    backdrop,
    dialog,
    headerEl,
    toolbarEl,
    searchEl,
    statusEl,
    bodyEl,
    footerEl,
    setBusy(b) {
      bodyEl.classList.toggle("is-busy", !!b);
    },
    setStatus(s) {
      statusEl.textContent = s || "";
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
                <option value="mtime:desc">Newest</option>
                <option value="mtime:asc">Oldest</option>
                <option value="name:asc">Name A→Z</option>
                <option value="name:desc">Name Z→A</option>
                <option value="size:desc">Largest file</option>
                <option value="size:asc">Smallest file</option>
                <option value="pixels:desc">Largest resolution</option>
                <option value="pixels:asc">Smallest resolution</option>
                <option value="rating:desc">Highest rating</option>
                <option value="rating:asc">Lowest rating</option>
            </select>
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
  const refs = {
    grid: root.querySelector(".gl-grid"),
    status: root.querySelector(".gl-status"),
    crumbs: root.querySelector(".gl-crumbs"),
    chips: chipsEl,
    search: root.querySelector(".gl-search"),
    path: root.querySelector(".gl-pathinput"),
    selected: root.querySelector(".gl-selected"),
    refresh: root.querySelector(".gl-refresh"),
    sort: root.querySelector(".gl-sort")
  };
  refs.sort.value = `${state.sortKey}:${state.sortDir}`;
  refs.sort.addEventListener("change", (e) => {
    const [key, dir] = e.target.value.split(":");
    state.sortKey = key;
    state.sortDir = dir;
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
  async function loadAndRender() {
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
      grid.appendChild(c);
    }
    const sortedFiles = sortFiles(state.files, state.sortKey, state.sortDir);
    for (const f of sortedFiles) {
      if (q && !f.name.toLowerCase().includes(q))
        continue;
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
      c.innerHTML = `
                <div class="gl-thumb"><img loading="lazy" decoding="async" data-src="${url}" alt=""></div>
                <div class="gl-name" title="${escapeHTML(titleText)}">${escapeHTML(f.name)}</div>
                ${dims ? `<div class="gl-dims">${dims}</div>` : ""}
                ${starsHTML("gl", ratingOf(f))}
            `;
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
  function installLazyThumbs(grid) {
    const imgs = grid.querySelectorAll("img[data-src]");
    if (!imgs.length)
      return;
    const io = new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (!e.isIntersecting)
          continue;
        const im = e.target;
        const src = im.dataset.src;
        if (src) {
          im.src = src;
          im.removeAttribute("data-src");
        }
        io.unobserve(im);
      }
    }, { root: grid, rootMargin: "200px" });
    for (const im of imgs)
      io.observe(im);
  }
  renderControls();
  loadAndRender();
  updateSelectedFooter();
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
function escapeHTML(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

// src/image-picker.ts
import { app as app2 } from "/scripts/app.js";
var EXT_NAME2 = "comfyui-gallery-loader";
var LIST_URL2 = "/gallery_loader/list";
var FILE_URL = "/gallery_loader/file";
var BASE_URL = "/gallery_loader/base";
var RATING_URL2 = "/gallery_loader/rating";
var STYLE_ID3 = "ip-style";
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
var VIDEO_EXTS = new Set([".mp4", ".webm", ".mov", ".mkv", ".avi", ".m4v", ".mpg", ".mpeg"]);
var SORT_STORAGE_KEY = "comfyui-gallery-loader:sort";
var VALID_SORTS = new Set([
  "mtime:desc",
  "mtime:asc",
  "name:asc",
  "name:desc",
  "size:desc",
  "pixels:desc",
  "rating:desc",
  "rating:asc"
]);
var SANDBOXED_TYPES = ["input", "output", "temp"];
var VIEW_STORAGE_KEY = "comfyui-gallery-loader:view";
var VIEW_PENDING_KEY = "comfyui-gallery-loader:view-pending";
function loadSavedView() {
  try {
    if (localStorage.getItem(VIEW_PENDING_KEY) === "1") {
      localStorage.removeItem(VIEW_PENDING_KEY);
      localStorage.setItem(VIEW_STORAGE_KEY, "folder");
      return { mode: "folder", recovered: true };
    }
    return {
      mode: localStorage.getItem(VIEW_STORAGE_KEY) === "flat" ? "flat" : "folder",
      recovered: false
    };
  } catch {
    return { mode: "folder", recovered: false };
  }
}
function saveView(mode) {
  try {
    localStorage.setItem(VIEW_STORAGE_KEY, mode);
  } catch {}
}
function markFlatPending(pending) {
  try {
    if (pending)
      localStorage.setItem(VIEW_PENDING_KEY, "1");
    else
      localStorage.removeItem(VIEW_PENDING_KEY);
  } catch {}
}
function loadSavedSort() {
  try {
    const raw = localStorage.getItem(SORT_STORAGE_KEY);
    if (!raw || !VALID_SORTS.has(raw))
      return null;
    const [key, dir] = raw.split(":");
    return { key, dir };
  } catch (e) {
    console.warn(`[${EXT_NAME2}] could not read saved sort`, e);
    return null;
  }
}
function saveSort(key, dir) {
  try {
    localStorage.setItem(SORT_STORAGE_KEY, `${key}:${dir}`);
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
function isImageUploadEntry(entry) {
  if (Array.isArray(entry) && entry.length >= 2) {
    const opts = entry[1];
    return !!opts && typeof opts === "object" && opts.image_upload === true;
  }
  if (entry && typeof entry === "object" && !Array.isArray(entry)) {
    return entry.image_upload === true;
  }
  return false;
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
      if (!isImageUploadEntry(entry))
        continue;
      if (Array.isArray(entry)) {
        entry[1].image_upload = false;
        entry[1]._origImageUpload = true;
      } else {
        entry.image_upload = false;
        entry._origImageUpload = true;
      }
      touched = true;
      debug(`defanged image_upload on ${nodeData?.name}.${name}`);
    }
  }
  return touched;
}
function findImageWidget(node) {
  if (!node?.widgets)
    return null;
  for (const w of node.widgets) {
    if (w?.options?._origImageUpload === true)
      return w;
  }
  const looksLikeLoader = node.comfyClass === "LoadImage" || node.comfyClass === "LoadImageMask" || node.comfyClass === "LoadImageOutput" || node.type === "LoadImage" || node.type === "LoadImageMask" || node.type === "LoadImageOutput";
  if (!looksLikeLoader)
    return null;
  for (const w of node.widgets) {
    if (w?.name === "image")
      return w;
  }
  return null;
}
function enhanceLoadImageNode(node) {
  if (!node?.widgets)
    return;
  if (node._galleryPickerEnhanced)
    return;
  const w = findImageWidget(node);
  if (!w)
    return;
  node._galleryPickerEnhanced = true;
  const v = (typeof w.value === "string" ? w.value : "").trim();
  if (/\[(output|temp)\]\s*$/.test(v)) {
    const values = w.options?.values;
    if (Array.isArray(values) && !values.includes(v))
      values.push(v);
  }
  debug(`enhancing ${node.comfyClass || node.type}:`, {
    widgetName: w.name,
    widgetType: w.type
  });
  const existing = w.options?.tooltip || "";
  const hint = "Click to open the gallery picker (or use the \uD83D\uDCC1 button below).";
  if (w.options) {
    w.options.tooltip = existing ? `${existing}

${hint}` : hint;
  }
  patchWidgetPointer(w, (_pointer, ownerNode) => {
    openImagePicker(w, ownerNode || node, { kind: "loadimage" });
    return true;
  });
  appendButtonWidget(node, "\uD83D\uDCC1 Browse gallery", () => {
    openImagePicker(w, node, { kind: "loadimage" });
  }, { logPrefix: EXT_NAME2 });
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
function joinAbs(dir, name) {
  const d = (dir || "/").replace(/\/+$/, "");
  return d === "" ? `/${name}` : `${d}/${name}`;
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
async function openImagePicker(widget, node, opts) {
  ensureStyleOnce(STYLE_ID3, PICKER_CSS);
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
  const savedSort = loadSavedSort();
  if (savedSort) {
    state.sortKey = savedSort.key;
    state.sortDir = savedSort.dir;
  }
  const savedView = loadSavedView();
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
  let initialSnapshot;
  if (kind === "loadimage") {
    const init = parseLoadImageValue(widget.value);
    state.type = init.type;
    state.subfolder = init.subfolder;
    state.currentName = init.name;
    initialSnapshot = { type: init.type, subfolder: init.subfolder, name: init.name };
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
  const titleByKind = kind === "loadimage" ? "Choose image" : mode === "directory" ? "Choose folder" : "Choose file";
  const footerLeftHTML = mode === "directory" ? "<kbd>Esc</kbd> close · click a folder to descend · click <b>Use this folder</b> to commit" : "<kbd>Esc</kbd> close · click a card to select · click a folder to descend";
  const modal = openModalShell({
    title: titleByKind,
    subtitle: `(${widget.name})`,
    placeholder: "Filter by filename…",
    width: "min(1100px, calc(100vw - 16px))",
    height: "min(88vh, 820px)",
    footerLeftHTML,
    footerRightHTML: '<span class="ip-count"></span>'
  });
  let tabsEl = null;
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
  let viewToggleEl = null;
  if (kind === "loadimage" && mode !== "directory") {
    viewToggleEl = document.createElement("button");
    viewToggleEl.type = "button";
    viewToggleEl.className = "ip-control ip-icon ip-view-toggle";
    viewToggleEl.title = "Flat view (all subfolders)";
    viewToggleEl.textContent = "≣";
  }
  modal.toolbarEl.append(crumbsEl, ...viewToggleEl ? [viewToggleEl] : [], sortEl, refreshEl);
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
    renderGrid();
  });
  sortEl.addEventListener("change", () => {
    const [k, d] = sortEl.value.split(":");
    state.sortKey = k;
    state.sortDir = d;
    saveSort(k, d);
    renderGrid();
  });
  refreshEl.addEventListener("click", () => loadAndRender());
  viewToggleEl?.addEventListener("click", () => {
    if (!SANDBOXED_TYPES.includes(state.type))
      return;
    state.viewMode = state.viewMode === "flat" ? "folder" : "flat";
    saveView(state.viewMode);
    loadAndRender();
  });
  if (tabsEl) {
    tabsEl.addEventListener("click", (e) => {
      const b = e.target.closest("[data-type]");
      if (!b)
        return;
      if (state.type === b.dataset.type)
        return;
      state.type = b.dataset.type;
      state.subfolder = "";
      loadAndRender();
    });
  }
  crumbsEl.addEventListener("click", (e) => {
    const c = e.target.closest("[data-sub], [data-abs]");
    if (!c)
      return;
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
    const target = e.target;
    if (target.closest(".ip-star"))
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
      const subEl = target.closest(".ip-subpath");
      if (subEl?.dataset.sub !== undefined) {
        e.stopPropagation();
        state.viewMode = "folder";
        saveView("folder");
        state.subfolder = subEl.dataset.sub || "";
        loadAndRender();
        return;
      }
      const f = fileOfCard(card);
      if (f)
        commitFile(f);
    }
  });
  function setStarRating(f, row, next) {
    const prev = Number(row.dataset.rating || "0");
    applyStars(row, next);
    f.rating = next;
    const addr = {
      type: state.type,
      subfolder: fileSub(f),
      absDir: state.absPath,
      name: f.name
    };
    postRating(RATING_URL2, addr, next).then((confirmed) => {
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
  function navigateUp() {
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
    return `${LIST_URL2}?${p.toString()}`;
  }
  async function loadAndRender() {
    renderTabs();
    renderCrumbs();
    renderViewToggle();
    modal.setBusy(true);
    modal.setStatus("Loading…");
    markFlatPending(isFlat());
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
    modal.setBusy(false);
    renderGrid();
    markFlatPending(false);
  }
  function thumbForFile(f) {
    const ext = (f.ext || "").toLowerCase();
    if (state.type === "path") {
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
      return { kind: "img", src: imageThumbURL(state.type, sub, f) };
    }
    if (VIDEO_EXTS.has(ext)) {
      return { kind: "video", src: videoSrcURL(state.type, sub, f.name) };
    }
    return { kind: "icon", text: "\uD83D\uDCC4" };
  }
  function renderGrid() {
    const q = state.query;
    gridEl.innerHTML = "";
    const flat = isFlat();
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
                <div class="ip-name" title="${escHTML(d.name)}">${escHTML(d.name)}</div>
            `;
      gridEl.appendChild(c);
    }
    let files = state.files;
    if (q) {
      const scored = [];
      for (const f of files) {
        const hay = flat && f.subpath ? `${f.subpath}/${f.name}` : f.name;
        const r = fuzzyScore(q, hay);
        if (r)
          scored.push({ f, score: r.score });
      }
      scored.sort((a, b) => b.score - a.score);
      files = scored.map((x) => x.f);
    } else {
      files = sortFiles2(files, state.sortKey, state.sortDir);
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
      const selected = flat ? state.type === initialSnapshot.type && fileSub(f) === initialSnapshot.subfolder && f.name === initialSnapshot.name : inSameLocation && f.name === initialSnapshot.name;
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
      const titleText = dims ? `${f.name}
${dims}
${when}` : `${f.name}
${when}`;
      const thumbInner = t.kind === "img" ? `<img loading="lazy" decoding="async" data-src="${t.src}" alt="">` : t.kind === "video" ? `<video muted playsinline preload="none" data-src="${t.src}"></video>` : `<div class="ip-thumb-icon">${t.text}</div>`;
      const stars = mode === "directory" ? "" : starsHTML("ip", ratingOf(f));
      const subLabel = flat ? f.subpath ? `<button type="button" class="ip-subpath" data-sub="${escHTML(fileSub(f))}" title="Go to ${escHTML(f.subpath)}">${escHTML(f.subpath)}</button>` : `<div class="ip-subpath is-root" title="Top level">/</div>` : "";
      c.innerHTML = `
                ${subLabel}
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
      el.textContent = mode === "directory" ? "No subfolders here." : "No matching files in this directory.";
      gridEl.appendChild(el);
    }
    if (useFolderEl) {
      useFolderEl.textContent = state.type === "path" ? `Use ${shortenPath(state.absPath)}` : `Use ${state.type}${state.subfolder ? `/${state.subfolder}` : ""}`;
    }
    setCount(visible, state.files.length);
    installLazyThumbs(gridEl);
    if (!state.didInitialScroll && !isFlat()) {
      state.didInitialScroll = true;
      scrollToSelected();
    }
  }
  function scrollToSelected() {
    const card = gridEl.querySelector(".ip-card.is-selected");
    if (!card)
      return;
    const body = modal.bodyEl;
    const target = card.offsetTop - Math.max(0, (body.clientHeight - card.offsetHeight) / 2);
    body.scrollTop = Math.max(0, target);
  }
  function shortenPath(p) {
    if (!p)
      return "/";
    if (p.length <= 48)
      return p;
    return `…${p.slice(-46)}`;
  }
  let thumbObserver = null;
  function installLazyThumbs(container) {
    thumbObserver?.disconnect();
    thumbObserver = null;
    if (typeof IntersectionObserver === "undefined")
      return;
    const els = container.querySelectorAll("img[data-src], video[data-src]");
    if (!els.length)
      return;
    const io = new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (!e.isIntersecting)
          continue;
        const el = e.target;
        const src = el.dataset.src;
        if (src) {
          if (el.tagName === "VIDEO") {
            el.preload = "metadata";
          }
          el.src = src;
          el.removeAttribute("data-src");
        }
        io.unobserve(el);
      }
    }, { root: modal.bodyEl, rootMargin: "300px" });
    for (const el of els)
      io.observe(el);
    thumbObserver = io;
  }
  function commitFile(f) {
    let value;
    if (state.type === "path") {
      value = joinAbs(state.absPath, f.name);
    } else {
      value = buildLoadImageValue(state.type, fileSub(f), f.name);
      const values = widget.options?.values;
      if (Array.isArray(values) && !values.includes(value)) {
        values.push(value);
      }
    }
    applyValue(value);
    modal.close();
  }
  function commitFolder() {
    const value = state.type === "path" ? state.absPath || "/" : state.subfolder ? state.subfolder : state.type;
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
  function sortFiles2(files, key, dir) {
    const mul = dir === "asc" ? 1 : -1;
    const nameCmp = (a, b) => a.name.localeCompare(b.name, undefined, {
      numeric: true,
      sensitivity: "base"
    });
    const numCmp = (getter) => (a, b) => (getter(a) ?? 0) - (getter(b) ?? 0) || nameCmp(a, b);
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
/* Kept for parity with sampler-info's si-match. */
.cmp-match {
    color: #ffd866;
    font-weight: 700;
}
`;
function escHTML(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}
try {
  app2.registerExtension({
    name: "comfy.gallery-loader.image-picker",
    async beforeRegisterNodeDef(_nodeType, nodeData) {
      try {
        defangNodeData(nodeData);
      } catch (e) {
        console.warn(`[${EXT_NAME2}] defang failed for ${nodeData?.name}`, e);
      }
    },
    setup() {
      ensureStyleOnce(STYLE_ID3, PICKER_CSS);
      debug("image-picker setup running");
      const nodes = app2?.graph?._nodes;
      if (Array.isArray(nodes)) {
        for (const n of nodes) {
          enhanceLoadImageNode(n);
          enhanceVHSPathNode(n);
        }
      }
    },
    nodeCreated(node) {
      enhanceLoadImageNode(node);
      enhanceVHSPathNode(node);
    },
    loadedGraphNode(node) {
      enhanceLoadImageNode(node);
      enhanceVHSPathNode(node);
    }
  });
} catch (e) {
  console.error(`[${EXT_NAME2}] image-picker.js: registerExtension threw`, e);
}
