#!/usr/bin/env python
"""Seed ComfyUI's input/output/temp dirs with sample images for screenshots.

This pack's picker grid lists *real files* from ComfyUI's media
directories (unlike sampler-info, whose picker renders from a static
Python list). A fresh ComfyUI clone has empty input/output/temp dirs, so
without seeding the screenshot grid would be blank. This script paints a
small corpus of visually distinct, varied-dimension PNGs at build time.

Pure-stdlib + PIL only - PIL ships with ComfyUI (Pillow dependency), so
no extra Python deps. Deterministic (hue derived from index, no RNG) and
idempotent (overwrites on re-run). Run inside the Docker build:

    python seed_images.py

Targets default to ``$COMFY_DIR/{input,output,temp}`` (``COMFY_DIR``
defaults to ``/opt/ComfyUI``). Override the root with ``COMFY_DIR`` or
pass explicit ``input output temp`` dirs as positional args.
"""

from __future__ import annotations

import colorsys
import os
import sys

from PIL import Image, ImageDraw, ImageFont, ImageOps

# (name, width, height) - varied aspect ratios so the grid's widthxheight
# meta line renders and the layout looks like a real gallery. The prefix
# groups by aspect; the zero-padded index keeps name-sort deterministic.
INPUT_SPECS = [
    ("landscape_01", 768, 512),
    ("portrait_02", 512, 768),
    ("square_03", 1024, 1024),
    ("square_04", 640, 640),
    ("wide_05", 1024, 576),
    ("tall_06", 576, 1024),
    ("landscape_07", 800, 600),
    ("portrait_08", 600, 800),
    ("square_09", 512, 512),
    ("wide_10", 1280, 720),
    ("tall_11", 720, 1280),
    ("square_12", 900, 900),
]
OUTPUT_SPECS = [
    ("render_01", 1024, 1024),
    ("render_02", 768, 512),
    ("render_03", 512, 768),
    ("upscaled_04", 1280, 720),
]
TEMP_SPECS = [
    ("preview_01", 640, 640),
    ("preview_02", 832, 512),
    ("preview_03", 512, 832),
]

# Base mtime (fixed epoch - Date.now() is avoided for determinism). Each
# seeded file gets a slightly later mtime by index so the default
# mtime:desc sort produces a meaningful, stable order.
_BASE_MTIME = 1_700_000_000

_FONT_CANDIDATES = [
    "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
]


def _load_font(size: int) -> ImageFont.FreeTypeFont | ImageFont.ImageFont:
    for path in _FONT_CANDIDATES:
        if os.path.exists(path):
            try:
                return ImageFont.truetype(path, size=size)
            except OSError:
                continue
    try:
        return ImageFont.load_default(size=size)
    except TypeError:  # Pillow < 10.1 - load_default takes no size
        return ImageFont.load_default()


def _hue_rgb(hue: float, light: float) -> tuple[int, int, int]:
    r, g, b = colorsys.hsv_to_rgb(hue % 1.0, 0.62, light)
    return int(r * 255), int(g * 255), int(b * 255)


def _gradient_l(style: int, width: int, height: int) -> Image.Image:
    """A grayscale (L-mode) gradient used as the tile base.

    Built at 256x256 in pure Python (fast - 65k pixels) then resized to
    the target dims. style cycles diagonal -> radial -> vertical.
    """
    n = 256
    base = Image.new("L", (n, n))
    px = base.load()
    if style == 1:  # radial
        cx = cy = (n - 1) / 2
        maxd = (cx**2 + cy**2) ** 0.5
        for y in range(n):
            for x in range(n):
                d = ((x - cx) ** 2 + (y - cy) ** 2) ** 0.5
                px[x, y] = 255 - int(d / maxd * 255)
    elif style == 2:  # vertical
        for y in range(n):
            v = int(y / (n - 1) * 255)
            for x in range(n):
                px[x, y] = v
    else:  # diagonal
        for y in range(n):
            for x in range(n):
                px[x, y] = (x + y) * 255 // (2 * (n - 1))
    return base.resize((width, height))


def _draw_label(img: Image.Image, name: str, dims: str) -> None:
    draw = ImageDraw.Draw(img)
    short_side = min(img.size)
    font = _load_font(max(20, short_side // 12))
    sub_font = _load_font(max(14, short_side // 20))
    cx, cy = img.size[0] / 2, img.size[1] / 2

    def centered(text: str, font_obj, y: float, fill: tuple[int, int, int]) -> None:
        box = draw.textbbox((0, 0), text, font=font_obj)
        w, h = box[2] - box[0], box[3] - box[1]
        x = cx - w / 2
        # Drop shadow for legibility against the gradient.
        draw.text((x + 2, y + 2), text, font=font_obj, fill=(0, 0, 0))
        draw.text((x, y), text, font=font_obj, fill=fill)
        return h

    label_h = centered(name, font, cy - short_side // 10, (255, 255, 255))
    centered(dims, sub_font, cy - short_side // 10 + label_h + 10, (235, 235, 235))


def _seed_dir(target: str, specs: list[tuple[str, int, int]], hue_offset: float) -> int:
    os.makedirs(target, exist_ok=True)
    written = 0
    for i, (name, w, h) in enumerate(specs):
        hue = (hue_offset + i / max(len(specs), 1)) % 1.0
        base = _gradient_l(i % 3, w, h)
        dark = _hue_rgb(hue, 0.30)
        light = _hue_rgb(hue, 0.92)
        img = ImageOps.colorize(base, black=dark, white=light).convert("RGB")
        _draw_label(img, name, f"{w}x{h}")
        path = os.path.join(target, f"{name}.png")
        img.save(path, "PNG")
        mtime = _BASE_MTIME + i * 60
        os.utime(path, (mtime, mtime))
        written += 1
    return written


def main(argv: list[str]) -> int:
    comfy_dir = os.environ.get("COMFY_DIR", "/opt/ComfyUI")
    if len(argv) >= 3:
        input_dir, output_dir, temp_dir = argv[0], argv[1], argv[2]
    else:
        input_dir = os.path.join(comfy_dir, "input")
        output_dir = os.path.join(comfy_dir, "output")
        temp_dir = os.path.join(comfy_dir, "temp")

    total = 0
    total += _seed_dir(input_dir, INPUT_SPECS, hue_offset=0.0)
    total += _seed_dir(output_dir, OUTPUT_SPECS, hue_offset=0.45)
    total += _seed_dir(temp_dir, TEMP_SPECS, hue_offset=0.72)
    print(
        f"Seeded {total} sample images: "
        f"{len(INPUT_SPECS)} -> {input_dir}, "
        f"{len(OUTPUT_SPECS)} -> {output_dir}, "
        f"{len(TEMP_SPECS)} -> {temp_dir}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
