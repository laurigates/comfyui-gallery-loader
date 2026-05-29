#!/usr/bin/env bash
#
# Launch ComfyUI headless, wait for it to be ready, then run the
# Playwright capture script. Exits non-zero if either screenshot is
# missing afterwards so a failed run surfaces in the build output.

set -euo pipefail

PORT="${COMFYUI_PORT:-8188}"
OUT_DIR="${OUT_DIR:-/out}"
COMFY_DIR="${COMFY_DIR:-/opt/ComfyUI}"
CAPTURE="${CAPTURE_SCRIPT:-/opt/screenshots/capture.mjs}"
READY_URL="http://127.0.0.1:${PORT}/system_stats"
READY_TIMEOUT="${READY_TIMEOUT:-120}"

mkdir -p "${OUT_DIR}"

cd "${COMFY_DIR}"
python main.py \
    --cpu \
    --listen 0.0.0.0 \
    --port "${PORT}" \
    --disable-auto-launch \
    >/tmp/comfyui.log 2>&1 &
COMFY_PID=$!

cleanup() {
    if kill -0 "${COMFY_PID}" 2>/dev/null; then
        kill "${COMFY_PID}" 2>/dev/null || true
        wait "${COMFY_PID}" 2>/dev/null || true
    fi
}
trap cleanup EXIT

echo "Waiting for ComfyUI to come up on ${READY_URL} (timeout: ${READY_TIMEOUT}s)…"
deadline=$(( $(date +%s) + READY_TIMEOUT ))
until curl -fs "${READY_URL}" >/dev/null 2>&1; do
    if ! kill -0 "${COMFY_PID}" 2>/dev/null; then
        echo "ComfyUI exited before becoming ready. Log tail:" >&2
        tail -n 200 /tmp/comfyui.log >&2 || true
        exit 1
    fi
    if [ "$(date +%s)" -ge "${deadline}" ]; then
        echo "ComfyUI did not become ready within ${READY_TIMEOUT}s. Log tail:" >&2
        tail -n 200 /tmp/comfyui.log >&2 || true
        exit 1
    fi
    sleep 1
done
echo "ComfyUI is ready."

node "${CAPTURE}"
status=$?

if [ ! -s "${OUT_DIR}/picker.png" ]; then
    echo "Missing or empty ${OUT_DIR}/picker.png after capture." >&2
    exit 1
fi
if [ ! -s "${OUT_DIR}/gallery.png" ]; then
    echo "Missing or empty ${OUT_DIR}/gallery.png after capture." >&2
    exit 1
fi

echo "Captured ${OUT_DIR}/picker.png and ${OUT_DIR}/gallery.png."
exit "${status}"
