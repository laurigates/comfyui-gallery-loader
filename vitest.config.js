import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const __dirname = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  test: {
    include: ["tests/js/**/*.test.js"],
    environment: "node",
  },
  resolve: {
    alias: {
      // Stub the ComfyUI frontend's app.js for tests that import picker modules.
      // The pure helper modules (modal-fuzzy) don't import app.js, so this is
      // here for picker-module tests that will follow.
      "../../../scripts/app.js": resolve(__dirname, "tests/js/__mocks__/app.js"),
    },
  },
});
