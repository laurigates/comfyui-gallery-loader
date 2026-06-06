// ComfyUI serves its frontend API at runtime from `/scripts/app.js`. The
// `@comfyorg/comfyui-frontend-types` package only types the bare-package
// symbols, not that served-path module. TypeScript will not match an ambient
// `declare module` against a rooted (`/…`) path specifier, so instead a
// `paths` mapping in tsconfig.json points the `/scripts/app.js` import at this
// declaration file. The emitted import string stays `/scripts/app.js` (bun's
// `--external '/scripts/*'` keeps it unbundled, resolved at runtime against
// ComfyUI's served module).
import type { ComfyApp } from "@comfyorg/comfyui-frontend-types";

export declare const app: ComfyApp;
