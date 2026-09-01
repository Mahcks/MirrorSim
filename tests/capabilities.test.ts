import { describe, expect, test } from "bun:test";

type ScopedPermission = {
  identifier?: string;
  allow?: Array<{ url?: string }>;
};

describe("desktop capabilities", () => {
  test("external links are limited to the destinations shown by MirrorSim", async () => {
    const capability = await Bun.file(new URL("../src-tauri/capabilities/default.json", import.meta.url)).json() as {
      permissions: Array<string | ScopedPermission>;
    };
    const opener = capability.permissions.find(
      (permission): permission is ScopedPermission => typeof permission === "object"
        && permission.identifier === "opener:allow-open-url",
    );

    expect(opener?.allow).toEqual([
      { url: "https://github.com/Mahcks/MirrorSim/releases/latest" },
      { url: "https://support.apple.com/kb/DL999" },
    ]);
    expect(opener?.allow?.some(({ url }) => url?.includes("*"))).toBe(false);
  });
});
