# syntax=docker/dockerfile:1.26
#
# Single-stage build for the README screenshot generator.
#
# Base image: the official Playwright image, which already has Node 22,
# Chromium, and every Chromium runtime dep installed. On top of that we
# install Python + clone ComfyUI + install CPU-only torch and ComfyUI's
# requirements.
#
# The entrypoint starts ComfyUI on :8188 (no models needed — the picker
# renders from sample images the build seeds into input/output/temp),
# waits for /system_stats to return 200, then runs the Playwright driver
# which writes /out/picker.png + /out/gallery.png.

# Pin to a real ComfyUI release. Bumping is a deliberate act — picker
# screenshots are sensitive to the frontend bundle that ships with this
# release. v0.22.0 ships comfyui-frontend-package==1.43.18, which clears
# the pack's >=1.40 floor (Strategy-A onPointerDown hook).
ARG COMFYUI_REF=v0.22.0

# Pinning the Playwright image version pins the Chromium revision too,
# which is the single largest source of cross-host font-rendering drift.
# Keep this in sync with the playwright version in package.json.
FROM mcr.microsoft.com/playwright:v1.49.1-noble

ARG COMFYUI_REF

ENV DEBIAN_FRONTEND=noninteractive \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PIP_BREAK_SYSTEM_PACKAGES=1

# Ubuntu Noble ships Python 3.12. We need pip + venv tooling and git
# for the ComfyUI clone. curl is already present from the base image.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        python3 python3-pip python3-venv git ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && ln -sf /usr/bin/python3 /usr/local/bin/python

WORKDIR /opt
RUN git clone --depth 1 --branch "${COMFYUI_REF}" \
    https://github.com/comfyanonymous/ComfyUI.git /opt/ComfyUI

WORKDIR /opt/ComfyUI

# CPU-only torch keeps the image lean and avoids CUDA driver dependencies.
RUN pip install --index-url https://download.pytorch.org/whl/cpu \
        torch torchvision torchaudio \
    && pip install -r requirements.txt

# Seed sample images into ComfyUI's input/output/temp dirs at build time
# so the picker grid is populated. Unlike sampler-info (whose picker
# renders from a static Python list), this pack's grid lists real files —
# a fresh clone has empty media dirs, so without this the grid is blank.
# PIL is present (ComfyUI depends on Pillow). Done here so the layer is
# cached and re-runs don't regenerate the corpus.
COPY screenshots/seed_images.py /opt/screenshots/seed_images.py
RUN python /opt/screenshots/seed_images.py

WORKDIR /opt/screenshots
COPY screenshots/package.json /opt/screenshots/package.json
# Chromium is pre-installed in the Playwright base image, so we only
# need the npm dependency for the driver script itself.
RUN npm install --omit=dev

# The pack lives under custom_nodes/ with the canonical directory name.
# This name is the served URL prefix (/extensions/comfyui-gallery-loader/),
# so don't rename it.
COPY . /opt/ComfyUI/custom_nodes/comfyui-gallery-loader

COPY screenshots/capture.mjs /opt/screenshots/capture.mjs
COPY screenshots/workflow.json /opt/screenshots/workflow.json
COPY screenshots/entrypoint.sh /opt/screenshots/entrypoint.sh
RUN chmod +x /opt/screenshots/entrypoint.sh

WORKDIR /opt/ComfyUI

VOLUME ["/out"]

ENTRYPOINT ["/opt/screenshots/entrypoint.sh"]
