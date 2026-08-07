// Stub for the `/scripts/app.js` runtime import (aliased in vitest.config.js).
//
// `registerExtension` records instead of discarding: the picker's node
// detection — which classes it takes over, which widget it hooks, which
// extension set it then asks the backend for — lives entirely in the
// registered hooks, and there is no other seam to reach it through.
export const registeredExtensions = [];

export const app = {
  registerExtension: (ext) => {
    registeredExtensions.push(ext);
    return ext;
  },
};

/** The extension registered under `name`, or undefined. */
export function extensionNamed(name) {
  return registeredExtensions.find((e) => e?.name === name);
}
