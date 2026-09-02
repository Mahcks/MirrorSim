import { describe, expect, test } from "bun:test";

import { formatPairingDeviceIdentity } from "../src/features/mirrorsim/components/PairingModal";

describe("pairing device identity", () => {
  test("keeps short identifiers intact", () => {
    expect(formatPairingDeviceIdentity("iPhone-1234")).toBe("iPhone-1234");
  });

  test("reduces long fingerprints to a readable suffix", () => {
    expect(formatPairingDeviceIdentity("7025cf7fbfa9f42acc6636f35495f43df4d3a15c10ff1"))
      .toBe("Device identity ending in 15C10FF1");
  });
});
