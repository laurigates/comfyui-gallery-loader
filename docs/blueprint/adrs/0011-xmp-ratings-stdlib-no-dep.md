---
id: ADR-0011
date: 2026-06-07
status: Accepted
deciders: Lauri Gates
domain: backend
supersedes: []
relates-to:
  - ADR-0002
  - ADR-0004
  - ADR-0005
  - ADR-0007
  - ADR-0008
github-issues: []
name: blueprint-derive-adr
---

# ADR-0011: XMP star ratings via stdlib-only in-file surgery (no new dependency)

## Context

The picker had no per-image rating. We want users to rate images with stars
and sort by rating, on both surfaces (the modal picker and the inline
`GalleryLoadImage` grid). The open question was **where the rating lives** and
**how it is written**, under two standing constraints: the value contract must
not churn (ADR-0008 — rating is display-only metadata, never changes the
committed widget value) and the extension whitelist is the security perimeter
(ADR-0004).

The user specified **XMP** as the vocabulary so ratings interoperate with
other tools. XMP's `xmp:Rating` (integer −1..5; we use 0..5, 0 = unrated) is
the cross-tool standard read/written by Lightroom, Adobe Bridge, Windows
Explorer, digiKam and others. We mirror it to `MicrosoftPhoto:Rating` (0/1/25/
50/75/99 percent) so Windows Explorer shows the stars too.

## Decision Drivers

- **No new Python dependencies** (ADR-0005) — the backend uses only
  ComfyUI-bundled libs. The user agreed to relax this *only* if a dependency
  were vetted and clearly necessary.
- Embedding XMP via **Pillow `save()` re-encodes the image** and, for PNG,
  risks dropping ComfyUI's own `prompt`/`workflow`/`parameters` text chunks —
  unacceptable for renders users care about. Pillow's `save(xmp=...)` only
  works for WebP/AVIF anyway.
- A capable library (**pyexiv2**) can write XMP losslessly in-place for
  PNG/JPEG, but it is **GPL-3.0** while this pack is **MIT** — a required
  GPL import would force relicensing the whole pack — and it is **not
  thread-safe**.

## Considered Options

1. **Stdlib-only in-file XMP surgery for PNG/JPEG + sidecar fallback** —
   write the XMP packet directly into the file's container structure with
   `struct`/`zlib`, copying all other bytes verbatim; fall back to a
   `<path>.xmp` sidecar for other formats.
2. **Add pyexiv2** — relicense the pack to GPL-3.0, use one code path.
3. **Sidecar-only (`<path>.xmp`)** — never touch the image; partial interop
   (Lightroom auto-reads sidecars only for RAW).
4. **SQLite/JSON store keyed by path** — simplest, but rating is private to
   this pack (not portable to other photo tools — fails the XMP goal).

## Decision Outcome

**Chosen: option 1 — stdlib-only in-file surgery with a sidecar fallback.**
Writing XMP without re-encoding turns out to be straightforward for the two
formats that matter, which removes the entire MIT-vs-GPL dilemma:

- **PNG** (dominant ComfyUI output): insert/replace an `iTXt` chunk
  (keyword `XML:com.adobe.xmp`) before the first `IDAT`, recomputing only that
  chunk's CRC32 with `zlib.crc32`. Every other chunk — including IDAT pixels
  and ComfyUI's text chunks — is copied **byte-for-byte**.
- **JPEG**: insert/replace the `APP1` segment (`0xFFE1`, prefixed
  `http://ns.adobe.com/xap/1.0/\0`) after SOI (after a leading APP0 if
  present); the compressed scan is copied verbatim. A 16-bit segment-size
  guard falls back to a sidecar if the packet would overflow (~64 KB; never
  hit by a rating packet). ExtendedXMP multi-segment is out of scope.
- **Everything else** (webp, avif, gif, tiff, video) and any in-file write
  that can't be done losslessly: a `<path>.xmp` **sidecar**.

Reading checks in-file XMP first (so ratings set by Lightroom/Windows are
honoured), then the sidecar. The XMP XML is parsed with stdlib `xml.etree`,
**size-capped** and with **DOCTYPE/ENTITY rejected** (XXE / billion-laughs
guard). Writes are atomic (temp file in the same directory + `os.replace`).

All of this lives in a new pure module **`xmp_meta.py`** (no ComfyUI imports →
unit-testable in a bare environment). `gallery_loader.py` gains a
**`POST /gallery_loader/rating`** endpoint (validated: integer 0..5,
separator-free filename, image/video extension gate — the same perimeter as
`/thumb` and `/file`) and attaches a `rating` field to each `/list` entry,
read through a small `(path, mtime_ns, size)` cache so re-listing is cheap.

### Positive Consequences

- Pack stays **MIT**, **zero new dependencies** — constraints intact.
- Ratings are **interoperable** (`xmp:Rating` + `MicrosoftPhoto:Rating`) and
  **lossless** in-place for PNG/JPEG; ComfyUI workflow chunks survive.
- The thin-backend posture (ADR-0002) and value contract (ADR-0008) are
  preserved; rating never changes the committed value.
- Pure byte-manipulation helpers fit ADR-0007's unit-test tier (round-trips
  proving other chunks survive; XXE/oversize/overflow rejection).

### Negative Consequences

- More backend code than a private store, and two read/write paths
  (in-file vs sidecar) to maintain.
- Ratings are keyed by file location; moving/renaming a file separates it from
  an in-file rating only if the mover drops the sidecar — in-file ratings
  travel with PNG/JPEG, sidecars do not.
- Writing changes the file mtime, so the `/thumb` ETag busts once after a
  rating change (a single re-encode of the thumbnail; acceptable).
- Sidecar interop is partial (Lightroom reads sidecars only for RAW); the
  in-file path covers the common PNG/JPEG case.

## Links

- `xmp_meta.py`, `tests/test_xmp.py`
- `gallery_loader.py` (`POST /gallery_loader/rating`, `/list` `rating` field,
  `_validate_rating_request`)
- `src/rating.ts` (shared star widget + POST), `src/image-picker.ts`,
  `src/gallery_loader.ts`
- ADR-0004 (extension whitelist), ADR-0005 (no new Python deps),
  ADR-0008 (value-format contract)

---
*Authored alongside the image-metadata rating feature.*
