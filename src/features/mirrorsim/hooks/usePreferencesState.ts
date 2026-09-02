import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";

import {
  defaultAppPreferences,
  defaultRecordingSettings,
  defaultScreenshotSettings,
  PREFERENCES_STORE_KEY,
} from "@/features/mirrorsim/constants";
import {
  getPreferencesStore,
  mergeStoredPreferences,
  readBrowserStoredPreferences,
  selectFreshestStoredPreferences,
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
  preferencesSaveError: string | null;
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
  const [browserStoredPreferences] = useState<StoredPreferences | null>(() => readBrowserStoredPreferences());
  const [initialPreferences] = useState(() => mergeStoredPreferences(browserStoredPreferences));
  const [preferencesReady, setPreferencesReady] = useState(false);
  const [preferencesSaveError, setPreferencesSaveError] = useState<string | null>(null);
  const [storeHydrated, setStoreHydrated] = useState(false);
  const saveRevisionRef = useRef(browserStoredPreferences?._meta?.revision ?? 0);
  const saveTimeoutRef = useRef<number | null>(null);
  const saveChainRef = useRef<Promise<void>>(Promise.resolve());
  const [screenshotSettings, setScreenshotSettings] = useState<ScreenshotSettings>(initialPreferences.screenshots ?? defaultScreenshotSettings);
  const [recordingSettings, setRecordingSettings] = useState<RecordingSettings>(initialPreferences.recordings ?? defaultRecordingSettings);
  const [appPreferences, setAppPreferences] = useState<AppPreferences>(initialPreferences.app ?? defaultAppPreferences);

  useEffect(() => {
    let cancelled = false;
    const cancelScheduledLoad = scheduleAfterFirstPaint(() => {
      void (async () => {
        try {
          const store = await getPreferencesStore();
          const nativeStored = (await store.get<StoredPreferences>(PREFERENCES_STORE_KEY)) ?? null;
          const stored = selectFreshestStoredPreferences(nativeStored, browserStoredPreferences);
          const merged = mergeStoredPreferences(stored);
          const persisted = {
            ...merged,
            _meta: stored?._meta ?? {
              revision: Math.max(1, saveRevisionRef.current),
              updatedAt: Date.now(),
            },
          } satisfies StoredPreferences;
          saveRevisionRef.current = Math.max(saveRevisionRef.current, persisted._meta.revision);

          if (!cancelled) {
            setScreenshotSettings(merged.screenshots);
            setRecordingSettings(merged.recordings);
            setAppPreferences(merged.app);
          }

          if (stored) {
            // Keep localStorage as a durable mirror. If the native store is
            // unavailable or the app closes during a debounced write, the
            // timestamped browser copy wins on the next launch.
            writeBrowserStoredPreferences(persisted);
            await store.set(PREFERENCES_STORE_KEY, persisted);
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

    const revision = ++saveRevisionRef.current;
    const preferences = {
      screenshots: screenshotSettings,
      recordings: recordingSettings,
      app: appPreferences,
      _meta: {
        revision,
        updatedAt: Date.now(),
      },
    } satisfies StoredPreferences;

    writeBrowserStoredPreferences(preferences);

    if (saveTimeoutRef.current !== null) {
      window.clearTimeout(saveTimeoutRef.current);
    }
    saveTimeoutRef.current = window.setTimeout(() => {
      saveTimeoutRef.current = null;
      saveChainRef.current = saveChainRef.current
        .catch(() => undefined)
        .then(async () => {
          try {
            const store = await getPreferencesStore();
            await store.set(PREFERENCES_STORE_KEY, preferences);
            await store.save();
            if (revision === saveRevisionRef.current) {
              setPreferencesSaveError(null);
            }
          } catch (error) {
            if (revision === saveRevisionRef.current) {
              setPreferencesSaveError(
                error instanceof Error
                  ? `Preferences were saved to the fallback store because the native settings store failed: ${error.message}`
                  : "Preferences were saved to the fallback store because the native settings store failed.",
              );
            }
          }
        });
    }, 200);

    return () => {
      if (saveTimeoutRef.current !== null) {
        window.clearTimeout(saveTimeoutRef.current);
        saveTimeoutRef.current = null;
      }
    };
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
    preferencesSaveError,
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
