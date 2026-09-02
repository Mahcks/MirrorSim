import { describe, expect, test } from "bun:test";

import { getModalVisibility, isPairingModalOpen } from "../src/features/mirrorsim/modalFlow";

describe("modal precedence", () => {
  test("pairing phases requiring user action preempt preferences", () => {
    for (const phase of ["pin-required", "awaiting-trust", "failed"] as const) {
      expect(isPairingModalOpen(phase)).toBe(true);
      expect(getModalVisibility(true, phase)).toEqual({
        pairingOpen: true,
        settingsOpen: false,
      });
    }
  });

  test("preferences remain available when pairing has no modal", () => {
    for (const phase of ["idle", "verifying", "paired"] as const) {
      expect(getModalVisibility(true, phase)).toEqual({
        pairingOpen: false,
        settingsOpen: true,
      });
    }
  });
});
