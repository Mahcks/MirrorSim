import { describe, expect, test } from "bun:test";

import { defaultRecordingSettings, defaultScreenshotSettings } from "../src/features/mirrorsim/constants";
import {
  buildRecordingFileName,
  buildScreenshotFileName,
  formatAppleDeviceModel,
  mergeStoredPreferences,
  selectFreshestStoredPreferences,
} from "../src/features/mirrorsim/helpers";

describe("capture filenames", () => {
  const timestamp = new Date(2026, 8, 1, 13, 4, 5);

  test("sanitizes screenshot filename components", () => {
    expect(
      buildScreenshotFileName(
        { ...defaultScreenshotSettings, fileNamePrefix: " demo/shot:* ", includeTimestamp: true },
        timestamp,
      ),
    ).toBe("demo-shot--_20260901_130405.png");
  });

  test("uses the webm extension for recordings", () => {
    expect(
      buildRecordingFileName(
        { ...defaultRecordingSettings, fileNamePrefix: "walkthrough", includeTimestamp: false },
        timestamp,
      ),
    ).toBe("walkthrough.webm");
  });
});

describe("preference snapshot recovery", () => {
  test("uses a newer browser fallback after a close-before-debounce", () => {
    const native = {
      app: { receiverDisplayName: "Old native value" },
      _meta: { revision: 3, updatedAt: 1_000 },
    };
    const browser = {
      app: { receiverDisplayName: "Latest browser value" },
      _meta: { revision: 4, updatedAt: 2_000 },
    };

    expect(selectFreshestStoredPreferences(native, browser)).toBe(browser);
  });

  test("keeps a newer native snapshot when the fallback is stale", () => {
    const native = {
      app: { receiverDisplayName: "Latest native value" },
      _meta: { revision: 8, updatedAt: 8_000 },
    };
    const browser = {
      app: { receiverDisplayName: "Stale browser value" },
      _meta: { revision: 7, updatedAt: 7_000 },
    };

    expect(selectFreshestStoredPreferences(native, browser)).toBe(native);
  });

  test("uses monotonic revision when the system clock moves backward", () => {
    const native = {
      app: { receiverDisplayName: "Older revision" },
      _meta: { revision: 10, updatedAt: 9_000 },
    };
    const browser = {
      app: { receiverDisplayName: "Newer revision" },
      _meta: { revision: 11, updatedAt: 8_000 },
    };

    expect(selectFreshestStoredPreferences(native, browser)).toBe(browser);
  });
});

test("stored preferences retain defaults for missing sections", () => {
  const merged = mergeStoredPreferences({ screenshots: { copyToClipboard: true } });
  expect(merged.screenshots.copyToClipboard).toBe(true);
  expect(merged.recordings.fileNamePrefix).toBe(defaultRecordingSettings.fileNamePrefix);
});

test("invalid stored preference values fall back to safe defaults", () => {
  const merged = mergeStoredPreferences({
    app: { launchMode: "broken" as "minimal", autoReconnectOnDrop: "yes" as unknown as boolean },
    screenshots: { saveLocation: "desktop" as "pictures" },
  });
  expect(merged.app.launchMode).toBe("minimal");
  expect(merged.app.autoReconnectOnDrop).toBe(true);
  expect(merged.screenshots.saveLocation).toBe("pictures");
});

test("Apple hardware identifiers are normalized", () => {
  expect(formatAppleDeviceModel("iPhone16,1")).toBe("iPhone 15 Pro");
  expect(formatAppleDeviceModel("FuturePhone1,1")).toBe("FuturePhone1,1");
});
