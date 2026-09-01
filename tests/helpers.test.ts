import { describe, expect, test } from "bun:test";

import { defaultRecordingSettings, defaultScreenshotSettings } from "../src/features/mirrorsim/constants";
import {
  buildRecordingFileName,
  buildScreenshotFileName,
  formatAppleDeviceModel,
  mergeStoredPreferences,
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
