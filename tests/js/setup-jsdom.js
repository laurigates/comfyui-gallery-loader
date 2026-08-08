// Vitest setup: restore `localStorage` in the jsdom environment.
//
// Node 22+ defines its OWN global `localStorage` accessor, which evaluates to
// `undefined` unless the process was started with `--localstorage-file`. Vitest
// populates the jsdom window's properties onto `globalThis` but SKIPS any name
// already defined there — so jsdom's real Storage never lands, and every jsdom
// test file dies in `beforeEach` on `localStorage.clear()`:
//
//     TypeError: Cannot read properties of undefined (reading 'clear')
//
// Observed on Node v26.5.0 with vitest 4.1.8 / jsdom 29, against test files
// that predate this pack's pin work. A browser always has localStorage, so
// installing a Storage-shaped shim restores the environment the picker actually
// runs in rather than papering over a behaviour difference — the pack's own
// reads are already try/catch-guarded for the private-mode case.
if (typeof globalThis.localStorage === "undefined") {
  const makeStorage = () => {
    const map = new Map();
    return {
      get length() {
        return map.size;
      },
      key: (i) => [...map.keys()][i] ?? null,
      getItem: (k) => (map.has(String(k)) ? map.get(String(k)) : null),
      setItem: (k, v) => {
        map.set(String(k), String(v));
      },
      removeItem: (k) => {
        map.delete(String(k));
      },
      clear: () => {
        map.clear();
      },
    };
  };
  for (const name of ["localStorage", "sessionStorage"]) {
    Object.defineProperty(globalThis, name, {
      value: makeStorage(),
      configurable: true,
      writable: true,
    });
  }
}
