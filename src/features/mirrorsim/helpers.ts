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

export const fmtError = (error: unknown) => (error instanceof Error ? error.message : String(error));

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
  return {
    screenshots: {
      ...defaultScreenshotSettings,
      ...(stored?.screenshots ?? {}),
    },
    recordings: {
      ...defaultRecordingSettings,
      ...(stored?.recordings ?? {}),
    },
    app: {
      ...defaultAppPreferences,
      ...(stored?.app ?? {}),
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