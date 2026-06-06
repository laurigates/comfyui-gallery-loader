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
      // ComfyUI's served-path runtime import. The TS source imports the
      // absolute `/scripts/app.js` form; vitest aliases it to the mock so
      // picker modules can be imported (and their module side-effect —
      // app.registerExtension — runs against the stub). The fuzzy-matcher
      // tests import from @laurigates/comfy-modal-kit and don't need it.
      "/scripts/app.js": resolve(__dirname, "tests/js/__mocks__/app.js"),
    },
  },
});
