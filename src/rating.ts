// rating.ts — shared star-rating helpers for both picker surfaces
// (image-picker.ts modal + gallery_loader.ts inline grid).
//
// Ratings are display-only metadata persisted via POST /gallery_loader/rating
// into the file's XMP (PNG/JPEG) or a sidecar. They never change the value the
// widget commits.

const EXT_NAME = "comfyui-gallery-loader";
const RATING_URL = "/gallery_loader/rating";
const MAX_RATING = 5;

export interface RatingAddress {
  type: string; // input | output | temp | path
  subfolder: string;
  absDir: string; // used when type === "path"
  name: string;
}

interface RatedFile {
  rating?: number;
}

// 0 for unrated/absent; clamps to the rated range.
export function ratingOf(f: RatedFile): number {
  const r = f.rating;
  return typeof r === "number" && r > 0 ? Math.min(MAX_RATING, Math.floor(r)) : 0;
}

// Clicking star `val` when the current rating is `cur`: clicking the current
// top star clears (0), otherwise sets `val`. Pure — unit-tested.
export function nextRating(cur: number, val: number): number {
  return val === cur ? 0 : val;
}

// JSON body for the POST, mirroring the addressing the picker already holds.
// Pure — unit-tested.
export function ratingRequestBody(addr: RatingAddress, rating: number): Record<string, unknown> {
  if (addr.type === "path") {
    return { type: "path", path: addr.absDir, name: addr.name, rating };
  }
  return { type: addr.type, subfolder: addr.subfolder, name: addr.name, rating };
}

// POST the rating; resolves to the server-confirmed rating or throws.
export async function postRating(addr: RatingAddress, rating: number): Promise<number> {
  const res = await fetch(RATING_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(ratingRequestBody(addr, rating)),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  if (!data.ok) throw new Error(data.error || "rating failed");
  return typeof data.rating === "number" ? data.rating : rating;
}

// Inner markup for a 5-star row. `prefix` is the CSS class namespace
// ("ip" or "gl"). The caller embeds this inside the card template.
export function starsHTML(prefix: string, rating: number): string {
  const r = ratingOf({ rating });
  let buttons = "";
  for (let i = 1; i <= MAX_RATING; i++) {
    const on = i <= r ? " is-on" : "";
    buttons += `<button type="button" class="${prefix}-star${on}" data-val="${i}" tabindex="-1">★</button>`;
  }
  return `<div class="${prefix}-stars" data-rating="${r}" title="Rate (click the active star to clear)">${buttons}</div>`;
}

// Repaint an existing star-row element to reflect `rating`.
export function applyStars(row: HTMLElement, rating: number): void {
  const r = ratingOf({ rating });
  row.dataset.rating = String(r);
  for (const s of row.querySelectorAll<HTMLElement>("[data-val]")) {
    s.classList.toggle("is-on", Number(s.dataset.val) <= r);
  }
}

export function warnRating(e: unknown): void {
  console.warn(`[${EXT_NAME}] rating update failed`, e);
}
