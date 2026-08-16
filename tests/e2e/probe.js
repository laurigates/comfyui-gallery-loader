// Instrumentation for the scroll-restore measurement.
//
// A PORT of comfyui-image-browser/tests/e2e/probe.js, which is where this was
// written and where the mechanism it measures used to live. It is a port rather
// than a shared module because it is dev-time tooling in two independently
// released packs with no shared devDependency between them; the pack-specific
// selectors (`.ip-*` here, `.ib-*` there) are parameters, and the measurement
// logic is deliberately identical so a number from one suite means the same as
// a number from the other.
//
// The question these probes exist to answer is NOT "did the offset survive" —
// it is *when* it was lost:
//
//   lost AT ASSIGNMENT  → the engine clamped, because the content was not (yet)
//                         tall enough for the offset we asked for. Fixing that
//                         means restoring later, or against a taller box.
//   lost AFTER          → the assignment took, and something moved it
//                         afterwards (scroll anchoring, a reflow, a second
//                         assignment). Fixing that means finding the mover.
//
// Inferring that distinction from a final `scrollTop` read is impossible, so we
// wrap the setter: `immediate` is read back in the SAME synchronous task as the
// write (uncontaminated by anything later), next to the `scrollHeight` /
// `clientHeight` that were in force when the write happened — i.e. the clamp
// bound that decided the outcome. Everything after that is a separate,
// timestamped record.

/**
 * Install the scrollTop spy + scroll-event log as an init script, so it is in
 * place before the bundle's module script runs (the modal, and therefore the
 * scroller, does not exist yet at this point — the spy is on
 * `Element.prototype` and filters by class at call time).
 */
export async function installScrollProbe(
  page,
  { selector = ".cmp-body", dialog = ".cmp-dialog", grid = ".ip-grid" } = {},
) {
  await page.addInitScript(
    ({ sel, dialogSel, gridSel }) => {
      const NATIVE = Object.getOwnPropertyDescriptor(Element.prototype, "scrollTop");
      const log = {
        sets: [],
        events: [],
        marks: [],
        gets: [],
        observes: [],
        rafs: [],
        t0: performance.now(),
      };
      // ONE counter shared by the scrollTop writes and the IntersectionObserver
      // registrations. Wall-clock timestamps cannot order two things that happen
      // in the same sub-millisecond task, and "did the observer get registered
      // before or after the restore" is exactly such a question.
      let seq = 0;
      const now = () => Number((performance.now() - log.t0).toFixed(1));
      // Armed by armKnock(): a one-shot, deliberately hostile move of the
      // scroller a few frames AFTER a restore write, standing in for the class of
      // late mover a single synchronous assignment cannot survive.
      let knock = null;
      const target = () => document.querySelector(sel);
      const isTarget = (el) => el instanceof Element && el.matches?.(sel);

      // Which bundle function performed the write. The bundle is built without
      // minification, so `renderGrid` / `loadAndRender` survive by name and the
      // two restore paths in browser.ts are distinguishable from each other —
      // without this, two writes 1 ms apart are indistinguishable in the log.
      function callers() {
        const lines = (new Error().stack || "").split("\n").slice(2, 7);
        return lines
          .map((l) => /at\s+([A-Za-z0-9_$.]+)\s/.exec(l)?.[1])
          .filter(Boolean)
          .slice(0, 4);
      }

      // ---- requestAnimationFrame ledger ----------------------------------
      //
      // "Nothing scheduled outlives the modal" cannot be inferred from scrollTop
      // writes: the restore's `step` early-returns on `!isConnected` BEFORE it
      // would write, so a leaked frame callback performs zero writes and a
      // write-counting assertion passes whether or not the chain was cancelled.
      // The schedule itself therefore has to be observable. Each record carries
      // whether the dialog was still in the document when the callback RAN (a
      // callback that runs with the dialog gone is the leak) and when it was
      // CANCELLED (the cancel that onClose performs happens after the shell has
      // already detached the dialog, so it is identifiable by the same field).
      const NATIVE_RAF = window.requestAnimationFrame.bind(window);
      const NATIVE_CAF = window.cancelAnimationFrame.bind(window);
      const dialogPresent = () => !!document.querySelector(dialogSel);
      window.requestAnimationFrame = function requestAnimationFrame(cb) {
        const rec = {
          seq: seq++,
          t: now(),
          by: callers(),
          ranAt: null,
          ranWithDialog: null,
          cancelledAt: null,
          cancelledWithDialog: null,
        };
        const id = NATIVE_RAF((ts) => {
          rec.ranAt = now();
          rec.ranWithDialog = dialogPresent();
          return cb(ts);
        });
        rec.id = id;
        if (log.rafs.length < 5000) log.rafs.push(rec);
        return id;
      };
      window.cancelAnimationFrame = function cancelAnimationFrame(id) {
        const rec = log.rafs.find((r) => r.id === id && r.ranAt === null && r.cancelledAt === null);
        if (rec) {
          rec.cancelledAt = now();
          rec.cancelledWithDialog = dialogPresent();
        }
        return NATIVE_CAF(id);
      };

      Object.defineProperty(Element.prototype, "scrollTop", {
        configurable: true,
        get() {
          const v = NATIVE.get.call(this);
          // READS are logged too, because "the position was never saved" and "the
          // position was saved and then lost" are different bugs with the same
          // symptom. `rememberScroll()` reads this property; if the element it
          // reads from is already detached or unrendered the read yields 0 in a
          // real engine (jsdom hands back whatever was last assigned, which is
          // exactly why the jsdom suite cannot see this), and the Map faithfully
          // stores a 0 that no later restore can undo.
          if (isTarget(this) && log.gets.length < 4000) {
            log.gets.push({
              t: now(),
              value: v,
              connected: this.isConnected,
              rendered: this.getClientRects().length > 0,
              by: callers(),
            });
          }
          return v;
        },
        set(v) {
          if (!isTarget(this)) {
            NATIVE.set.call(this, v);
            return;
          }
          const before = NATIVE.get.call(this);
          // Read geometry BEFORE the write. These reads flush pending layout, so
          // they report the box the engine will clamp against — which is exactly
          // the number in dispute.
          const scrollHeight = this.scrollHeight;
          const clientHeight = this.clientHeight;
          NATIVE.set.call(this, v);
          // How many thumbnails had actually loaded when this write happened.
          // `.ip-thumb` is `aspect-ratio: 1/1`, so the claim is that card height —
          // and therefore `scrollHeight` — is already final with zero images
          // decoded. That claim is only worth anything measured: `imgsLoaded: 0`
          // next to a full-size `scrollHeight` is the proof.
          const grid = document.querySelector(gridSel);
          log.sets.push({
            seq: seq++,
            t: now(),
            requested: v,
            before,
            immediate: NATIVE.get.call(this),
            scrollHeight,
            clientHeight,
            maxScrollTop: Math.max(0, scrollHeight - clientHeight),
            clamped: NATIVE.get.call(this) !== v,
            imgs: grid ? grid.querySelectorAll("img").length : 0,
            imgsLoaded: grid ? grid.querySelectorAll("img[src]").length : 0,
            by: callers(),
          });
          if (knock && !knock.fired) {
            knock.fired = true;
            let left = knock.afterFrames;
            const hit = () => {
              if (left-- > 0) {
                requestAnimationFrame(hit);
                return;
              }
              const knocked = target();
              NATIVE.set.call(knocked, knock.value);
              // Read back in the SAME task as the shove: this is the proof the
              // scroller really moved. A correction that lands in a later rAF
              // callback of the same frame is invisible to a per-frame sampler,
              // so without this the test could not tell "the knock was undone
              // immediately" from "the knock never happened".
              knock.readBack = NATIVE.get.call(knocked);
              knock.at = now();
            };
            requestAnimationFrame(hit);
          }
        },
      });

      // WHEN the lazy-thumb observer starts watching, relative to the restore
      // write. The observer's root must be the scroller; a registration that
      // happens BEFORE the restore has its first pass computed against the
      // pre-restore viewport.
      const NATIVE_OBSERVE = IntersectionObserver.prototype.observe;
      IntersectionObserver.prototype.observe = function observe(el) {
        if (this.root instanceof Element && this.root.matches(sel) && log.observes.length < 2000) {
          log.observes.push({ seq: seq++, t: now(), tag: el.tagName });
        }
        return NATIVE_OBSERVE.call(this, el);
      };

      // `scroll` does not bubble, but capture listeners on ancestors still see it
      // — so one document-level listener covers a scroller that does not exist
      // yet. This is how a post-assignment mover (scroll anchoring, a reflow)
      // announces itself.
      document.addEventListener(
        "scroll",
        (e) => {
          if (!isTarget(e.target)) return;
          log.events.push({ t: now(), scrollTop: NATIVE.get.call(e.target) });
        },
        true,
      );

      // A card's top in SCROLL-CONTENT coordinates, derived from rects rather
      // than `offsetTop`: `offsetTop` is measured from the nearest positioned
      // ancestor, which is not guaranteed to be the scroller, and a constant
      // header-sized error would silently shift every band comparison.
      function contentTop(card, scroller) {
        return (
          card.getBoundingClientRect().top -
          scroller.getBoundingClientRect().top +
          NATIVE.get.call(scroller)
        );
      }

      window.__GL_PROBE__ = {
        reset() {
          log.sets.length = 0;
          log.events.length = 0;
          log.marks.length = 0;
          log.gets.length = 0;
          log.observes.length = 0;
          log.rafs.length = 0;
          knock = null;
          log.t0 = performance.now();
        },
        dump() {
          return {
            sets: log.sets,
            events: log.events,
            marks: log.marks,
            gets: log.gets,
            observes: log.observes,
            rafs: log.rafs,
          };
        },
        /**
         * Only the frame callbacks a named bundle function scheduled — the
         * restore chain is the kit's `restore` (its first frame) and then
         * `step` (every frame after that), both inlined into the bundle.
         */
        rafsBy(name) {
          return log.rafs.filter((r) => r.by.includes(name));
        },
        /**
         * Arm a one-shot knock: `afterFrames` frames after the NEXT scrollTop
         * write the bundle makes, shove the scroller to `value` through the
         * native setter.
         *
         * This is the hostile late mover a single synchronous assignment has no
         * answer to. It is a SIMULATION of that class of event (an engine-side
         * adjustment, a fling still settling), not a reproduction of any one of
         * them — deliberately programmatic, so it does not look like a user
         * gesture and does not trip the "the user took the scroller" guard, which
         * is the case a restore is supposed to win.
         */
        armKnock(value = 0, afterFrames = 2) {
          knock = { value, afterFrames, fired: false, at: null, readBack: null };
        },
        knockRecord() {
          return knock;
        },
        /** Only the reads a named bundle function performed. */
        getsBy(name) {
          return log.gets.filter((g) => g.by.includes(name));
        },
        /** A labelled geometry snapshot, interleaved into the same timeline. */
        mark(label) {
          const el = target();
          const snap = {
            label,
            t: now(),
            scrollTop: el ? NATIVE.get.call(el) : null,
            scrollHeight: el?.scrollHeight ?? null,
            clientHeight: el?.clientHeight ?? null,
          };
          snap.maxScrollTop = el ? Math.max(0, snap.scrollHeight - snap.clientHeight) : null;
          log.marks.push(snap);
          return snap;
        },
        /** Set scrollTop through the NATIVE setter (not logged as a bundle write). */
        seed(v) {
          const el = target();
          NATIVE.set.call(el, v);
          return {
            requested: v,
            immediate: NATIVE.get.call(el),
            maxScrollTop: Math.max(0, el.scrollHeight - el.clientHeight),
          };
        },
        /** scrollTop sampled once per frame — "a few frames later", literally. */
        async frames(count = 30) {
          const out = [];
          for (let i = 0; i < count; i++) {
            await new Promise((r) => requestAnimationFrame(r));
            // Re-resolved every frame and allowed to be missing: the leak check
            // runs frames AFTER the dialog is gone, and "no scroller" is a valid
            // state to sample, not a crash.
            const el = target();
            out.push({
              frame: i,
              t: now(),
              scrollTop: el ? NATIVE.get.call(el) : null,
              scrollHeight: el ? el.scrollHeight : null,
            });
          }
          return out;
        },
        /**
         * Which file-card indices the lazy-thumb observer should be fetching for
         * the CURRENT offset — the viewport band widened by the observer's own
         * `rootMargin: 300px`. Compared against the names actually requested,
         * this is what decides whether the observer's first pass ran against the
         * pre-restore or the post-restore viewport.
         */
        band(margin = 300) {
          const el = target();
          const top = NATIVE.get.call(el);
          const lo = top - margin;
          const hi = top + el.clientHeight + margin;
          const idx = [];
          for (const c of document.querySelectorAll(".ib-card.is-file")) {
            const t = contentTop(c, el);
            if (t + c.offsetHeight >= lo && t <= hi) idx.push(Number(c.dataset.idx));
          }
          return {
            scrollTop: top,
            first: idx.length ? Math.min(...idx) : null,
            last: idx.length ? Math.max(...idx) : null,
            count: idx.length,
          };
        },
        /** Geometry of one card, for offset→index arithmetic. */
        cardAt(idx) {
          const el = target();
          const c = document.querySelector(`.ib-card.is-file[data-idx="${idx}"]`);
          return c ? { idx, contentTop: contentTop(c, el), height: c.offsetHeight } : null;
        },
        /**
         * A card index comfortably inside the current viewport — so a Playwright
         * click on it cannot trigger a scroll-into-view, which would move the very
         * offset under measurement before the code under test ever ran.
         */
        cardInView(pad = 24) {
          const el = target();
          const top = NATIVE.get.call(el);
          const bottom = top + el.clientHeight;
          for (const c of document.querySelectorAll(".ib-card.is-file")) {
            const t = contentTop(c, el);
            if (t >= top + pad && t + c.offsetHeight <= bottom - pad) return Number(c.dataset.idx);
          }
          return null;
        },
      };
    },
    { sel: selector, dialogSel: dialog, gridSel: grid },
  );
}

/**
 * Record every `/gallery_loader/thumb` request, in order, with the card index
 * its filename encodes.
 *
 * The fixture names files `img-NNNN.png` in mtime-descending order, which is
 * the default sort — so filename index IS card index, and a fetched band can be
 * compared directly against a viewport band with no extra bookkeeping.
 */
export function trackThumbs(page) {
  const reqs = [];
  page.on("request", (r) => {
    const u = r.url();
    if (!u.includes("/gallery_loader/thumb")) return;
    const q = new URL(u).searchParams;
    const name = q.get("name") || "";
    const m = /img-(\d+)\.png/.exec(name);
    reqs.push({
      name,
      subfolder: q.get("subfolder") ?? "",
      idx: m ? Number(m[1]) - 1 : null,
      t: Date.now(),
    });
  });
  return {
    all: reqs,
    get count() {
      return reqs.length;
    },
    /** Mark the current position so a later `since()` returns only new ones. */
    cut() {
      return reqs.length;
    },
    since(n) {
      return reqs.slice(n);
    },
  };
}
