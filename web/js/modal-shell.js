// modal-shell.js — reusable modal dialog shell for ComfyUI custom-node packs.
//
// A bare modal shell, not a picker: backdrop + centered dialog with header
// (title + close), optional toolbar slot, optional search input, scrollable
// body, optional footer. The consumer fills `bodyEl` with whatever DOM and
// event wiring it wants; the shell handles CSS injection, keyboard ESC,
// single-modal-at-a-time discipline, focus, and touch-friendly dismiss.
//
// Future plan: extract this file (plus modal-fuzzy.js) into its own
// frontend-only pack — e.g. "comfyui-modal-lib" — so other packs can
// `import { openModalShell } from "/extensions/comfyui-modal-lib/js/modal-shell.js"`.
// Until that extraction, the public surface here (the openModalShell options
// shape + the controller returned) is the contract. Keep it stable.
//
// CSS is namespaced under `.cmp-*` ("Comfy Modal Picker"). All ids on
// elements outside the cmp- prefix are explicitly avoided.

const STYLE_ID = "cmp-shell-style";

// Single-modal-at-a-time. Opening a new shell dismisses the previous one.
let ACTIVE = null;

const CSS = `
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

function ensureStyle() {
  if (document.getElementById(STYLE_ID)) return;
  const s = document.createElement("style");
  s.id = STYLE_ID;
  s.textContent = CSS;
  document.head.appendChild(s);
}

function dismissActive() {
  if (!ACTIVE) return;
  const a = ACTIVE;
  ACTIVE = null;
  try {
    a.backdrop.remove();
    a.dialog.remove();
    document.removeEventListener("keydown", a._onKey, true);
  } finally {
    try {
      a.opts.onClose?.();
    } catch (e) {
      console.warn("[modal-shell] onClose threw", e);
    }
  }
}

/**
 * Open a modal shell.
 *
 * @param {object} opts
 * @param {string} [opts.title]                  Header title text.
 * @param {string} [opts.subtitle]               Greyed-out suffix in the header (e.g. widget name).
 * @param {string} [opts.placeholder]            Search input placeholder. Falls back to "Filter…".
 * @param {boolean} [opts.showSearch=true]       Show the search row.
 * @param {boolean} [opts.showFooter=true]       Show the footer row.
 * @param {string} [opts.footerLeftHTML]         Inner HTML for the footer's left cell.
 * @param {string} [opts.footerRightHTML]        Inner HTML for the footer's right cell.
 * @param {string} [opts.width]                  CSS for `.cmp-dialog.width`. Overrides default.
 * @param {string} [opts.height]                 CSS for `.cmp-dialog.max-height`. Overrides default.
 * @param {(e: KeyboardEvent) => void} [opts.onKeyDown]  Forwarded after the shell handles ESC.
 * @param {() => void} [opts.onClose]            Called once after dismiss (both user- and programmatic-close).
 * @returns {{
 *   backdrop: HTMLElement, dialog: HTMLElement,
 *   headerEl: HTMLElement, toolbarEl: HTMLElement,
 *   searchEl: HTMLInputElement, statusEl: HTMLElement,
 *   bodyEl: HTMLElement, footerEl: HTMLElement,
 *   setBusy: (b: boolean) => void,
 *   setStatus: (s: string) => void,
 *   close: () => void,
 *   opts: object,
 * }}
 */
export function openModalShell(opts = {}) {
  ensureStyle();
  dismissActive();

  const backdrop = document.createElement("div");
  backdrop.className = "cmp-backdrop";
  // pointerdown, not click — on touch, the synthetic click that follows
  // touchend (~300ms) would re-fire on the just-mounted backdrop and
  // dismiss immediately. Pointerdown is not re-synthesized.
  backdrop.addEventListener("pointerdown", dismissActive);

  const dialog = document.createElement("div");
  dialog.className = "cmp-dialog";
  if (opts.width) dialog.style.width = opts.width;
  if (opts.height) dialog.style.maxHeight = opts.height;
  // Keep clicks inside the dialog from reaching the canvas.
  const stop = (e) => e.stopPropagation();
  for (const ev of ["pointerdown", "pointerup", "click", "dblclick", "wheel"]) {
    dialog.addEventListener(ev, stop);
  }

  // Header
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
  closeBtn.addEventListener("click", dismissActive);
  headerEl.append(titleEl, closeBtn);

  // Toolbar (always present but hidden when empty via :empty selector)
  const toolbarEl = document.createElement("div");
  toolbarEl.className = "cmp-toolbar";

  // Search row
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
  if (opts.showSearch === false) searchRow.style.display = "none";

  // Body
  const bodyEl = document.createElement("div");
  bodyEl.className = "cmp-body";

  // Footer
  const footerEl = document.createElement("div");
  footerEl.className = "cmp-footer";
  if (opts.showFooter !== false) {
    const l = document.createElement("div");
    if (opts.footerLeftHTML) l.innerHTML = opts.footerLeftHTML;
    const r = document.createElement("div");
    if (opts.footerRightHTML) r.innerHTML = opts.footerRightHTML;
    footerEl.append(l, r);
  } else {
    footerEl.style.display = "none";
  }

  dialog.append(headerEl, toolbarEl, searchRow, bodyEl, footerEl);

  // Keyboard
  const onKey = (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      dismissActive();
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
    close: dismissActive,
    _onKey: onKey,
    opts,
  };

  ACTIVE = controller;

  // Defer focus until after the originating tap event settles, so iOS
  // doesn't fight with the soft keyboard.
  if (opts.showSearch !== false) {
    requestAnimationFrame(() => {
      // Re-check ACTIVE in case the caller closed synchronously.
      if (ACTIVE === controller) searchEl.focus();
    });
  }

  return controller;
}

/** Programmatically close any currently-open shell. No-op if none. */
export function closeModalShell() {
  dismissActive();
}
