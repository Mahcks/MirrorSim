import { useEffect, useState, type Dispatch, type SetStateAction } from "react";

import {
  defaultAppPreferences,
  defaultRecordingSettings,
  defaultScreenshotSettings,
  PREFERENCES_STORE_KEY,
} from "@/features/mirrorsim/constants";
import {
  clearBrowserStoredPreferences,
  getPreferencesStore,
  mergeStoredPreferences,
  readBrowserStoredPreferences,
  writeBrowserStoredPreferences,
} from "@/features/mirrorsim/helpers";
import type { AppPreferences, RecordingSettings, ScreenshotSettings, StoredPreferences } from "@/features/mirrorsim/types";

function scheduleAfterFirstPaint(callback: () => void, delayMs = 0) {
  let timeoutId: number | null = null;
  const frameId = window.requestAnimationFrame(() => {
    timeoutId = window.setTimeout(callback, delayMs);
  });

  return () => {
    window.cancelAnimationFrame(frameId);
    if (timeoutId !== null) {
      window.clearTimeout(timeoutId);
    }
  };
}

type PreferencesState = {
  preferencesReady: boolean;
  screenshotSettings: ScreenshotSettings;
  setScreenshotSettings: Dispatch<SetStateAction<ScreenshotSettings>>;
  setScreenshotSetting: <K extends keyof ScreenshotSettings>(key: K, value: ScreenshotSettings[K]) => void;
  recordingSettings: RecordingSettings;
  setRecordingSettings: Dispatch<SetStateAction<RecordingSettings>>;
  setRecordingSetting: <K extends keyof RecordingSettings>(key: K, value: RecordingSettings[K]) => void;
  appPreferences: AppPreferences;
  setAppPreferences: Dispatch<SetStateAction<AppPreferences>>;
  setAppPreference: <K extends keyof AppPreferences>(key: K, value: AppPreferences[K]) => void;
};

export function usePreferencesState(): PreferencesState {
  const browserStoredPreferences = readBrowserStoredPreferences();
  const initialPreferences = mergeStoredPreferences(browserStoredPreferences);
  const [preferencesReady, setPreferencesReady] = useState(true);
  const [storeHydrated, setStoreHydrated] = useState(false);
  const [screenshotSettings, setScreenshotSettings] = useState<ScreenshotSettings>(initialPreferences.screenshots ?? defaultScreenshotSettings);
  const [recordingSettings, setRecordingSettings] = useState<RecordingSettings>(initialPreferences.recordings ?? defaultRecordingSettings);
  const [appPreferences, setAppPreferences] = useState<AppPreferences>(initialPreferences.app ?? defaultAppPreferences);

  useEffect(() => {
    let cancelled = false;
    const cancelScheduledLoad = scheduleAfterFirstPaint(() => {
      void (async () => {
        try {
          const store = await getPreferencesStore();
          const stored = (await store.get<StoredPreferences>(PREFERENCES_STORE_KEY)) ?? browserStoredPreferences;
          const merged = mergeStoredPreferences(stored);

          if (!cancelled) {
            setScreenshotSettings(merged.screenshots);
            setRecordingSettings(merged.recordings);
            setAppPreferences(merged.app);
          }

          if (stored) {
            await store.set(PREFERENCES_STORE_KEY, merged);
            clearBrowserStoredPreferences();
            await store.save();
          }
        } catch {
          // Browser fallback was already applied synchronously.
        } finally {
          if (!cancelled) {
            setStoreHydrated(true);
            setPreferencesReady(true);
          }
        }
      })();
    }, 120);

    return () => {
      cancelled = true;
      cancelScheduledLoad();
    };
  }, [browserStoredPreferences]);

  useEffect(() => {
    if (!preferencesReady || !storeHydrated) {
      return;
    }

    const preferences = {
      screenshots: screenshotSettings,
      recordings: recordingSettings,
      app: appPreferences,
    } satisfies StoredPreferences;

    writeBrowserStoredPreferences(preferences);

    void (async () => {
      try {
        const store = await getPreferencesStore();
        await store.set(PREFERENCES_STORE_KEY, preferences);
        await store.save();
      } catch {
        // browser fallback already wrote above
      }
    })();
  }, [appPreferences, preferencesReady, recordingSettings, screenshotSettings]);

  function setScreenshotSetting<K extends keyof ScreenshotSettings>(key: K, value: ScreenshotSettings[K]) {
    setScreenshotSettings((previous) => ({
      ...previous,
      [key]: value,
    }));
  }

  function setRecordingSetting<K extends keyof RecordingSettings>(key: K, value: RecordingSettings[K]) {
    setRecordingSettings((previous) => ({
      ...previous,
      [key]: value,
    }));
  }

  function setAppPreference<K extends keyof AppPreferences>(key: K, value: AppPreferences[K]) {
    setAppPreferences((previous) => ({
      ...previous,
      [key]: value,
    }));
  }

  return {
    preferencesReady,
    screenshotSettings,
    setScreenshotSettings,
    setScreenshotSetting,
    recordingSettings,
    setRecordingSettings,
    setRecordingSetting,
    appPreferences,
    setAppPreferences,
    setAppPreference,
  };
}