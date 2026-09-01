import { load as loadStore } from "@tauri-apps/plugin-store";

import {
  defaultAppPreferences,
  defaultRecordingSettings,
  defaultScreenshotSettings,
  LEGACY_SCREENSHOT_SETTINGS_STORAGE_KEY,
  PREFERENCES_STORAGE_KEY,
  PREFERENCES_STORE_PATH,
} from "./constants";
import type { RecordingSettings, ScreenshotSettings, StoredPreferences } from "./types";

let preferencesStorePromise: ReturnType<typeof loadStore> | null = null;

const APPLE_MODEL_NAMES: Record<string, string> = {
  "iphone9,1": "iPhone 7",
  "iphone9,2": "iPhone 7 Plus",
  "iphone9,3": "iPhone 7",
  "iphone9,4": "iPhone 7 Plus",
  "iphone10,1": "iPhone 8",
  "iphone10,2": "iPhone 8 Plus",
  "iphone10,3": "iPhone X",
  "iphone10,4": "iPhone 8",
  "iphone10,5": "iPhone 8 Plus",
  "iphone10,6": "iPhone X",
  "iphone11,2": "iPhone XS",
  "iphone11,4": "iPhone XS Max",
  "iphone11,6": "iPhone XS Max",
  "iphone11,8": "iPhone XR",
  "iphone12,1": "iPhone 11",
  "iphone12,3": "iPhone 11 Pro",
  "iphone12,5": "iPhone 11 Pro Max",
  "iphone12,8": "iPhone SE (2nd generation)",
  "iphone13,1": "iPhone 12 mini",
  "iphone13,2": "iPhone 12",
  "iphone13,3": "iPhone 12 Pro",
  "iphone13,4": "iPhone 12 Pro Max",
  "iphone14,2": "iPhone 13 Pro",
  "iphone14,3": "iPhone 13 Pro Max",
  "iphone14,4": "iPhone 13 mini",
  "iphone14,5": "iPhone 13",
  "iphone14,6": "iPhone SE (3rd generation)",
  "iphone14,7": "iPhone 14",
  "iphone14,8": "iPhone 14 Plus",
  "iphone15,2": "iPhone 14 Pro",
  "iphone15,3": "iPhone 14 Pro Max",
  "iphone15,4": "iPhone 15",
  "iphone15,5": "iPhone 15 Plus",
  "iphone16,1": "iPhone 15 Pro",
  "iphone16,2": "iPhone 15 Pro Max",
  "iphone17,1": "iPhone 16 Pro",
  "iphone17,2": "iPhone 16 Pro Max",
  "iphone17,3": "iPhone 16",
  "iphone17,4": "iPhone 16 Plus",
  "iphone17,5": "iPhone 16e",
  "ipadair5,1": "iPad Air (M2, 11-inch)",
  "ipadair5,2": "iPad Air (M2, 13-inch)",
  "ipadair6,1": "iPad Air (M3, 11-inch)",
  "ipadair6,2": "iPad Air (M3, 13-inch)",
  "ipad13,16": "iPad Air (5th generation)",
  "ipad13,17": "iPad Air (5th generation)",
  "ipad14,3": "iPad Pro 11-inch (4th generation)",
  "ipad14,4": "iPad Pro 11-inch (4th generation)",
  "ipad14,5": "iPad Pro 12.9-inch (6th generation)",
  "ipad14,6": "iPad Pro 12.9-inch (6th generation)",
  "ipad16,3": "iPad Pro (M4, 11-inch)",
  "ipad16,4": "iPad Pro (M4, 11-inch)",
  "ipad16,5": "iPad Pro (M4, 13-inch)",
  "ipad16,6": "iPad Pro (M4, 13-inch)",
};

export const fmtError = (error: unknown) => (error instanceof Error ? error.message : String(error));

export function formatAppleDeviceModel(model: string | null | undefined) {
  const trimmed = model?.trim();
  if (!trimmed) {
    return null;
  }

  return APPLE_MODEL_NAMES[trimmed.toLowerCase()] ?? trimmed;
}

export function readBufferedEnd(video: HTMLVideoElement) {
  try {
    return video.buffered.length === 0 ? 0 : video.buffered.end(video.buffered.length - 1);
  } catch {
    return 0;
  }
}

export function fmtDuration(seconds: number): string {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainingSeconds = seconds % 60;

  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, "0")}:${String(remainingSeconds).padStart(2, "0")}`
    : `${String(minutes).padStart(2, "0")}:${String(remainingSeconds).padStart(2, "0")}`;
}

function fmtFilenameDate(date: Date): string {
  return (
    `${date.getFullYear()}` +
    `${String(date.getMonth() + 1).padStart(2, "0")}` +
    `${String(date.getDate()).padStart(2, "0")}_` +
    `${String(date.getHours()).padStart(2, "0")}` +
    `${String(date.getMinutes()).padStart(2, "0")}` +
    `${String(date.getSeconds()).padStart(2, "0")}`
  );
}

function sanitizeFilenamePart(value: string): string {
  const sanitized = value.trim().replace(/[<>:"/\\|?*\x00-\x1F]/g, "-").replace(/\s+/g, "_");
  return sanitized || "mirrorsim_screenshot";
}

export function buildScreenshotFileName(settings: ScreenshotSettings, now: Date): string {
  const prefix = sanitizeFilenamePart(settings.fileNamePrefix);
  return settings.includeTimestamp ? `${prefix}_${fmtFilenameDate(now)}.png` : `${prefix}.png`;
}

export function buildRecordingFileName(settings: RecordingSettings, now: Date): string {
  const prefix = sanitizeFilenamePart(settings.fileNamePrefix);
  return settings.includeTimestamp ? `${prefix}_${fmtFilenameDate(now)}.webm` : `${prefix}.webm`;
}

export function uint8ArrayToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;

  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }

  return btoa(binary);
}

export function mergeStoredPreferences(stored: StoredPreferences | null) {
  const booleanOr = (value: unknown, fallback: boolean) => typeof value === "boolean" ? value : fallback;
  const stringOr = (value: unknown, fallback: string) => typeof value === "string" ? value : fallback;
  const enumOr = <T extends string>(value: unknown, allowed: readonly T[], fallback: T): T =>
    typeof value === "string" && allowed.includes(value as T) ? value as T : fallback;
  const screenshots = stored?.screenshots;
  const recordings = stored?.recordings;
  const app = stored?.app;

  return {
    screenshots: {
      saveToDisk: booleanOr(screenshots?.saveToDisk, defaultScreenshotSettings.saveToDisk),
      copyToClipboard: booleanOr(screenshots?.copyToClipboard, defaultScreenshotSettings.copyToClipboard),
      saveLocation: enumOr(screenshots?.saveLocation, ["pictures", "documents", "downloads", "custom"], defaultScreenshotSettings.saveLocation),
      customSavePath: stringOr(screenshots?.customSavePath, defaultScreenshotSettings.customSavePath),
      fileNamePrefix: stringOr(screenshots?.fileNamePrefix, defaultScreenshotSettings.fileNamePrefix),
      includeTimestamp: booleanOr(screenshots?.includeTimestamp, defaultScreenshotSettings.includeTimestamp),
    },
    recordings: {
      saveLocation: enumOr(recordings?.saveLocation, ["pictures", "documents", "downloads", "custom"], defaultRecordingSettings.saveLocation),
      customSavePath: stringOr(recordings?.customSavePath, defaultRecordingSettings.customSavePath),
      fileNamePrefix: stringOr(recordings?.fileNamePrefix, defaultRecordingSettings.fileNamePrefix),
      includeTimestamp: booleanOr(recordings?.includeTimestamp, defaultRecordingSettings.includeTimestamp),
      autoReveal: booleanOr(recordings?.autoReveal, defaultRecordingSettings.autoReveal),
    },
    app: {
      launchMode: enumOr(app?.launchMode, ["console", "minimal"], defaultAppPreferences.launchMode),
      previewQualityPreset: enumOr(app?.previewQualityPreset, ["quality", "balanced", "speed"], defaultAppPreferences.previewQualityPreset),
      receiverAccessMode: enumOr(app?.receiverAccessMode, ["ask", "remember-trusted", "known-only"], defaultAppPreferences.receiverAccessMode),
      useOpaqueWindowBackground: booleanOr(app?.useOpaqueWindowBackground, defaultAppPreferences.useOpaqueWindowBackground),
      rememberLastMode: booleanOr(app?.rememberLastMode, defaultAppPreferences.rememberLastMode),
      rememberLastOrientation: booleanOr(app?.rememberLastOrientation, defaultAppPreferences.rememberLastOrientation),
      keepMinimalOnTop: booleanOr(app?.keepMinimalOnTop, defaultAppPreferences.keepMinimalOnTop),
      autoRevealSavedCaptures: booleanOr(app?.autoRevealSavedCaptures, defaultAppPreferences.autoRevealSavedCaptures),
      screenshotFlashEnabled: booleanOr(app?.screenshotFlashEnabled, defaultAppPreferences.screenshotFlashEnabled),
      autoStartDiscovery: booleanOr(app?.autoStartDiscovery, defaultAppPreferences.autoStartDiscovery),
      autoReconnectOnDrop: booleanOr(app?.autoReconnectOnDrop, defaultAppPreferences.autoReconnectOnDrop),
      openDiagnosticsOnError: booleanOr(app?.openDiagnosticsOnError, defaultAppPreferences.openDiagnosticsOnError),
      receiverDisplayName: stringOr(app?.receiverDisplayName, defaultAppPreferences.receiverDisplayName),
      lastMode: enumOr(app?.lastMode, ["console", "minimal"], defaultAppPreferences.lastMode),
      lastOrientation: enumOr(app?.lastOrientation, ["portrait", "landscape"], defaultAppPreferences.lastOrientation),
    },
  };
}

export function readBrowserStoredPreferences(): StoredPreferences | null {
  try {
    const rawPreferences = localStorage.getItem(PREFERENCES_STORAGE_KEY);
    if (rawPreferences) {
      return JSON.parse(rawPreferences) as StoredPreferences;
    }

    const legacyScreenshotSettings = localStorage.getItem(LEGACY_SCREENSHOT_SETTINGS_STORAGE_KEY);
    if (!legacyScreenshotSettings) {
      return null;
    }

    return {
      screenshots: JSON.parse(legacyScreenshotSettings) as Partial<ScreenshotSettings>,
    };
  } catch {
    clearBrowserStoredPreferences();
    return null;
  }
}

export function writeBrowserStoredPreferences(preferences: StoredPreferences) {
  try {
    localStorage.setItem(PREFERENCES_STORAGE_KEY, JSON.stringify(preferences));
    localStorage.removeItem(LEGACY_SCREENSHOT_SETTINGS_STORAGE_KEY);
  } catch {
    // best-effort browser fallback only
  }
}

export function clearBrowserStoredPreferences() {
  try {
    localStorage.removeItem(PREFERENCES_STORAGE_KEY);
    localStorage.removeItem(LEGACY_SCREENSHOT_SETTINGS_STORAGE_KEY);
  } catch {
    // best-effort browser cleanup only
  }
}

export async function getPreferencesStore() {
  if (!preferencesStorePromise) {
    preferencesStorePromise = loadStore(PREFERENCES_STORE_PATH);
  }

  return preferencesStorePromise;
}
