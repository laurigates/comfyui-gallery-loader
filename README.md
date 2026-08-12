# comfyui-gallery-loader

Touch-friendly gallery picker for ComfyUI image, video and path widgets.

Four complementary entry points share one card-grid picker:

1. **`Load Image (Gallery)` node** — drop-in `LoadImage` replacement
   with the picker rendered inline on the node body. Cards scroll
   independently of the LiteGraph canvas, so it works on mobile and
   tablet.
2. **Modal picker over stock `LoadImage`** — clicking the `image`
   widget on any `LoadImage` / `LoadImageMask` / `LoadImageOutput`
   opens a card-grid modal with **Input / Output / Temp** tabs.
3. **Modal picker over the video and folder loaders** — core
   `LoadVideo`, plus VHS's `VHS_LoadVideo`, `VHS_LoadVideoFFmpeg` and
   `VHS_LoadImages`. Same three tabs, video posters on the cards, and a
   folder picker for the directory loader.
4. **Filesystem browser for VHS path-loader nodes** — `📁 Browse`
   button on `VHS_LoadImagePath`, `VHS_LoadImagesPath`,
   `VHS_LoadVideoPath`, and `VHS_LoadVideoFFmpegPath` opens the modal
   rooted at the ComfyUI install directory. Video files preview as
   `<video>` thumbnails; directory loaders get a footer "Use this
   folder" commit button.

## Why

ComfyUI's native image dropdown is alphabetical, single-column, and
unsearchable. The card grid is the same UX as the output panel:
mtime-sorted by default, fuzzy-searchable, with image thumbnails or
video posters. On mobile/tablet the grid is the only viable picker —
the native LiteGraph dropdown is unusable on touch.

## Install

ComfyUI Manager → "Install Custom Nodes" → search for **Gallery
Loader**. Or clone manually:

```sh
cd ComfyUI/custom_nodes
git clone https://github.com/laurigates/comfyui-gallery-loader
# restart ComfyUI; no Python deps beyond what ComfyUI core ships
```

## `Load Image (Gallery)` node

![inline gallery grid on the GalleryLoadImage node](docs/gallery.png)

| Output  | Type   | Notes                                          |
|---------|--------|------------------------------------------------|
| `image` | IMAGE  | Same loading semantics as the core `LoadImage`. |
| `mask`  | MASK   | Alpha channel inverted, matching core.          |
| `path`  | STRING | Resolved on-disk path — handy for SaveImage filename reuse / metadata. |

The widget stores either an annotated path (`subdir/foo.png [output]`)
or a bare absolute path. Both forms resolve via
`folder_paths.get_annotated_filepath`.

## Modal over stock LoadImage

![modal picker over LoadImage with Input/Output/Temp tabs](docs/picker.png)

Click the `image` combo widget — instead of the native dropdown, the
modal opens with three source tabs:

| Tab    | Reads from               | Commits value as     |
|--------|--------------------------|----------------------|
| Input  | `ComfyUI/input/`         | `subdir/foo.png`     |
| Output | `ComfyUI/output/`        | `subdir/foo.png [output]` |
| Temp   | `ComfyUI/temp/`          | `subdir/foo.png [temp]`   |

The annotated values are resolved transparently by core `LoadImage`
via `folder_paths.get_annotated_filepath`. Existing workflows that
target `input/` keep using the bare-relative form — no value churn.

A `📁 Browse gallery` button is also added below the widget so the
picker is reachable even on frontends that hijack the combo's click
through the Vue Asset Browser overlay.

## Video and folder loaders

The same modal, the same three tabs, over the upload-flavour video and
directory combos:

| Node                  | Widget      | Mode      | Lists                                  |
|-----------------------|-------------|-----------|----------------------------------------|
| `LoadVideo` (core)    | `file`      | File      | `.mp4 .webm .mov .mkv .avi .m4v .mpg .mpeg` |
| `VHS_LoadVideo`       | `video`     | File      | `.webm .mp4 .mkv .gif .mov`            |
| `VHS_LoadVideoFFmpeg` | `video`     | File      | `.webm .mp4 .mkv .gif .mov`            |
| `VHS_LoadImages`      | `directory` | Directory | (folder picker)                        |

Every one of these resolves its value through
`folder_paths.get_annotated_filepath`, so the `[output]` / `[temp]`
forms load exactly like the bare input names their native dropdowns
offer — which is what lets you pick a render straight out of `output/`
without copying it into `input/` first.

The VHS video sets mirror VHS's own `video_extensions` list, so the
grid shows precisely what each node's native dropdown would. `.gif` is
in that list and renders as a still thumbnail rather than a `<video>`.

`VHS_LoadImages` opens **inside** its currently selected folder: file
cards are inert, clicking a folder descends, and the footer
**"Use this folder"** button commits. At a root the committed value is
`.` (which resolves to the root itself) rather than an empty string.

Video cards use a `<video preload="metadata">` poster, loaded lazily as
the card scrolls into view — the same treatment the VHS path loaders
already got. There is no `ⓘ` metadata button on a video card; the
metadata endpoint reads image formats only.

## Pins

Two kinds of pin, one list:

- **`📌` in the toolbar** pins the folder you're in. Pinned folders render as
  chips on their own toolbar row — tap to jump there, `✕` to unpin.
- **`📌` on an image card** pins that single file. The **`📌 pinned`** tab then
  shows every pinned file, from every root, in one grid — each labelled with its
  full address (`output/2026-08-04/`). Tapping the label navigates there;
  **tapping the card commits the value immediately**, so a favourite image is one
  tap from any `LoadImage` node with no navigation at all.

The list lives on the **server**, in `<user_dir>/comfy-pins.json` — not in the
browser. That is what makes it work across devices (your phone and your desktop
are two browsers against one ComfyUI, which `localStorage` structurally cannot
span) and across packs: [comfyui-image-browser](https://github.com/laurigates/comfyui-image-browser)
reads and writes the same file, so a pin made in either shows up in the other.
An older browser-side pin list is migrated into it once, automatically.

Because the store is a file on the ComfyUI host, pins are **per-install, not
per-user** — a second person using that same ComfyUI shares the list.

A pin whose file has been deleted or moved is not silently dropped ("the file
moved" and "you never pinned it" are different facts): it renders dimmed,
refuses to commit, and can be cleared individually with `📌` or in bulk with
**Prune missing**.

The pinned tab is offered on file pickers only — a directory picker commits a
folder, so a pinned-media view has nothing to offer there — and pins address the
three sandboxed roots only, never a VHS absolute path.

## Safe View

Matches a keyword list against file and folder names and blurs the thumbnails
that hit, blocks out their names, and — optionally — drops them from the
listing entirely. It exists for the ordinary case of browsing your own renders
on a phone with someone else in the room.

**This is discretion, not access control.** A CSS blur is one devtools override
away from gone, and the blurred bytes are still downloaded and still sit in the
browser cache. It defeats a shoulder, not an adversary. Nothing here is a
permission boundary: every endpoint still serves any file you address directly,
exactly as it did before.

The toolbar `👁` / `🙈` toggles it; the eye is also a row in the Touch Tools
chooser. Settings live under **Settings → Touch Tools → Safe View**:

| Setting | Default | What it does |
|---|---|---|
| Safe View | on | Master switch. With no keywords it filters nothing, so "on" is inert until you add one. |
| Keywords | `nsfw` | Comma- or space-separated. |
| Remove matches from the listing entirely | off | Drops matches server-side so they never reach the browser. |
| Block out names too | on | Replaces the name, its folder label and its tooltip with a solid block. |
| Also match the generation prompt and model | off | Not implemented yet — see below. |

Keywords match **whole words**, never substrings. `nsfw` matches
`output/nsfw/pic.png` and `my_nsfw_pic.png`; it does **not** match
`nsfwish.png`, and `ass` does **not** match `assets/`. Matching is
case-insensitive and runs against the file name plus every folder above it,
including the root — so `temp` blurs everything under the temp tab. A blurred
card carries a `👁` that reveals just that card, until you change folder or
close the picker.

The keywords and every toggle are **shared with
[comfyui-image-browser](https://github.com/laurigates/comfyui-image-browser)** —
both packs register the same settings, so one keyword list covers both, and
because ComfyUI stores settings server-side it follows you across devices. If
both packs are installed you will see one benign `console.warn` about a
duplicate setting id at load; that is the sharing mechanism working, not a
fault.

### What it does not cover

Worth reading before relying on it — these are known gaps, not bugs:

- **Folders are matched by name only.** A blandly-named folder full of
  sensitive files is not caught in folder view, because a folder card carries
  nothing else to match on. Flat view (`≣`) lists the files themselves and does
  catch them.
- **Confirmations and toasts name files in plain text.** A rating failure or a
  pin error names the file it was about, unblurred.
- **The metadata panel (`ⓘ`) shows the full prompt**, whether or not the card
  is blurred. Prompt/model matching is a later phase; the setting for it is
  listed above but does nothing yet.
- **A node's own canvas preview is untouched.** A fresh render appears
  full-size on the graph, unfiltered — that is ComfyUI's own output preview and
  nothing in this pack can reach it.
- **Nothing is encrypted, moved, or access-controlled.** The files stay exactly
  where they are, readable by anything else on the machine.

## VHS path-loader integration

VHS path widgets are detected via `widget.options.vhs_path_extensions`.
A `📁 Browse files` / `📁 Browse folder` button opens the modal in
path-mode, rooted at `folder_paths.base_path` (or inside the widget's
current value if set). Selected files commit as a raw absolute path —
the format VHS already accepts.

| Node                          | Mode      | Extensions      |
|-------------------------------|-----------|-----------------|
| `VHS_LoadImagePath`           | File      | Image formats   |
| `VHS_LoadImagesPath`          | Directory | (folder picker) |
| `VHS_LoadVideoPath`           | File      | Video formats   |
| `VHS_LoadVideoFFmpegPath`     | File      | Video formats   |

Directory mode: file cards render but are inert; clicking a folder
descends, clicking the footer **"Use this folder"** button commits
the current absolute path.

## Endpoints

| Route                         | Purpose                                                                 |
|-------------------------------|-------------------------------------------------------------------------|
| `GET /gallery_loader/list`    | Directory listing. Params: `type=input\|output\|temp\|path`, `subfolder`, `path`, `extensions` (CSV), plus `safe_kw` (CSV keywords) + `safe_hide=1` for Safe View's server-side hide. Both Safe View params are required together; either alone filters nothing. Hiding is applied **above** the newest-N cap, so a mostly-sensitive folder still returns a full page of the rest. Image dims (width/height) are populated for image entries only. |
| `GET /gallery_loader/base`    | Returns `base_path`, `input_dir`, `output_dir`, `temp_dir`, `user_dir`. Used by the modal to default VHS path-mode to the ComfyUI install root. |
| `GET /gallery_loader/thumb`   | Webp 512px thumbnail for images at an arbitrary absolute path. Managed-type listings use core `/api/view` directly. |
| `GET /gallery_loader/file`    | Streams a whitelisted-extension file (images + common video formats) at an absolute path. Used for video posters in path-mode where core `/api/view` doesn't apply. |
| `GET /gallery_loader/pins`    | The pin list, every entry resolved: `{ok, max, pins}`, each pin carrying `exists` plus (for a live file pin) the same per-file keys `/list` emits. An unresolvable pin is returned with `exists: false`, never dropped. |
| `POST /gallery_loader/pins`   | One **delta** — `{op: "add"\|"remove"\|"prune", item?}` — never a whole-list PUT (two open browsers would each send their own list and the second write would discard the first's pin). Answers with the same whole list as the GET. `add` on an existing pin is a successful no-op. |

## Compatibility

- ComfyUI frontend `>= 1.40` (widget `onPointerDown` hook).
- Works alongside the legacy node combo and the modern Vue Asset
  Browser — the modal strips `image_upload` / `video_upload` from node
  specs before the widget is constructed, falling back to a plain
  canvas combo whose click we can intercept. `audio_upload` and
  `mesh_upload` combos are left alone; the picker can't serve them, so
  they keep their native control.

## License

MIT — see `LICENSE`.
