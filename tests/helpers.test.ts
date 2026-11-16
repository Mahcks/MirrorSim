import { describe, expect, test } from "bun:test";

import { defaultRecordingSettings, defaultScreenshotSettings } from "../src/features/mirrorsim/constants";
import {
  buildRecordingFileName,
  buildScreenshotFileName,
  canCapturePreviewFrame,
  fmtBytes,
  formatAppleDeviceModel,
  mergeStoredPreferences,
  selectFreshestStoredPreferences,
} from "../src/features/mirrorsim/helpers";

describe("preview screenshot availability", () => {
  test("keeps a retained frame captureable during transport reconnect", () => {
    expect(canCapturePreviewFrame("connecting", true, false)).toBe(true);
    expect(canCapturePreviewFrame("connecting", false, true)).toBe(false);
  });

  test("requires an active or retained frame in a live session", () => {
    expect(canCapturePreviewFrame("mirroring", false, true)).toBe(true);
    expect(canCapturePreviewFrame("recording", true, false)).toBe(true);
    expect(canCapturePreviewFrame("discovering", true, true)).toBe(false);
    expect(canCapturePreviewFrame("idle", true, true)).toBe(false);
  });
});

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

  test("uses the recorded container's extension", () => {
    const settings = { ...defaultRecordingSettings, fileNamePrefix: "walkthrough", includeTimestamp: false };
    expect(buildRecordingFileName(settings, timestamp, "mp4")).toBe("walkthrough.mp4");
    expect(buildRecordingFileName(settings, timestamp, "webm")).toBe("walkthrough.webm");
  });

  test("records MP4 by default", () => {
    expect(defaultRecordingSettings.format).toBe("mp4");
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
  expect(merged.screenshots.includeDeviceFrame).toBe(false);
  expect(merged.recordings.includeDeviceFrame).toBe(false);
  expect(merged.recordings.includeAudio).toBe(true);
  expect(merged.app.followIphoneVolume).toBe(true);
  expect(merged.app.audioChannelMode).toBe("stereo");
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

test("stored audio volume is clamped to a safe range", () => {
  expect(mergeStoredPreferences({ app: { audioVolume: 3 } }).app.audioVolume).toBe(1);
  expect(mergeStoredPreferences({ app: { audioVolume: -2 } }).app.audioVolume).toBe(0);
});

test("Apple hardware identifiers are normalized", () => {
  expect(formatAppleDeviceModel("iPhone16,1")).toBe("iPhone 15 Pro");
  expect(formatAppleDeviceModel("FuturePhone1,1")).toBe("FuturePhone1,1");
});

describe("recording polish settings", () => {
  test("default to a 3 second countdown without audio normalization", () => {
    const merged = mergeStoredPreferences({});
    expect(merged.recordings.countdownSeconds).toBe(3);
    expect(merged.recordings.normalizeAudio).toBe(false);
  });

  test("keep a valid countdown and reject anything else", () => {
    expect(mergeStoredPreferences({ recordings: { countdownSeconds: 0 } }).recordings.countdownSeconds).toBe(0);
    expect(mergeStoredPreferences({ recordings: { countdownSeconds: 5 } }).recordings.countdownSeconds).toBe(5);
    expect(mergeStoredPreferences({ recordings: { countdownSeconds: 7 as 5 } }).recordings.countdownSeconds).toBe(3);
    expect(mergeStoredPreferences({ recordings: { countdownSeconds: "3" as unknown as 3 } }).recordings.countdownSeconds).toBe(3);
  });
});

test("recording sizes read naturally", () => {
  expect(fmtBytes(0)).toBe("0 KB");
  expect(fmtBytes(512 * 1024)).toBe("512 KB");
  expect(fmtBytes(4.25 * 1024 * 1024)).toBe("4.3 MB");
  expect(fmtBytes(1.5 * 1024 * 1024 * 1024)).toBe("1.50 GB");
});
