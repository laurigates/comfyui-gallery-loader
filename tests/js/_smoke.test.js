// Smoke test — verifies the Vitest harness is wired up correctly.

import { expect, test } from "vitest";

test("vitest harness wired", () => {
  expect(1).toBe(1);
});
