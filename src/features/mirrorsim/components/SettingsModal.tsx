import type {
  AppMode,
  AppPreferences,
  PreviewQualityPreset,
  RecordingSettings,
  ScreenshotSaveLocation,
  ScreenshotSettings,
} from "@/features/mirrorsim/types";

type SettingsModalProps = {
  open: boolean;
  appPreferences: AppPreferences;
  screenshotSettings: ScreenshotSettings;
  recordingSettings: RecordingSettings;
  previewPresetDescription: string;
  onClose: () => void;
  setAppPreference: <K extends keyof AppPreferences>(key: K, value: AppPreferences[K]) => void;
  setScreenshotSetting: <K extends keyof ScreenshotSettings>(key: K, value: ScreenshotSettings[K]) => void;
  setRecordingSetting: <K extends keyof RecordingSettings>(key: K, value: RecordingSettings[K]) => void;
  onChooseScreenshotFolder: () => void;
  onChooseRecordingFolder: () => void;
};

export function SettingsModal({
  open,
  appPreferences,
  screenshotSettings,
  recordingSettings,
  previewPresetDescription,
  onClose,
  setAppPreference,
  setScreenshotSetting,
  setRecordingSetting,
  onChooseScreenshotFolder,
  onChooseRecordingFolder,
}: SettingsModalProps) {
  if (!open) {
    return null;
  }

  return (
    <div
      className="fixed inset-0 z-[240] flex items-start justify-center overflow-y-auto bg-black/60 p-4 backdrop-blur-sm sm:items-center"
      onMouseDown={onClose}
    >
      <div
        className="flex max-h-[calc(100dvh-2rem)] w-full max-w-[460px] flex-col overflow-hidden rounded-[28px] border border-white/10 bg-[#17191d] p-5 shadow-[0_24px_72px_rgba(0,0,0,0.52)]"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-lg font-semibold tracking-[-0.02em] text-white">Preferences</h2>
            <p className="mt-1 text-sm text-white/45">Control launch behavior, captures, connection defaults, and diagnostics.</p>
          </div>
          <button
            type="button"
            className="inline-flex h-8 items-center justify-center rounded-full border border-white/10 px-3 text-xs font-medium text-white/70 transition hover:bg-white/8 hover:text-white"
            onClick={onClose}
          >
            Close
          </button>
        </div>

        <div className="mt-5 min-h-0 flex-1 space-y-4 overflow-y-auto pr-1">
          <div className="rounded-2xl border border-white/8 bg-white/[0.03] p-4">
            <div className="text-[11px] font-semibold uppercase tracking-[0.08em] text-white/35">General</div>
            <label className="mt-3 block text-xs font-medium uppercase tracking-[0.06em] text-white/35">Launch Mode</label>
            <select
              className="mt-2 w-full rounded-xl border border-white/10 bg-[#111315] px-3 py-2 text-sm text-white outline-none"
              value={appPreferences.launchMode}
              onChange={(event) => setAppPreference("launchMode", event.target.value as AppMode)}
            >
              <option value="console">Console</option>
              <option value="minimal">Minimal</option>
            </select>
            <label className="mt-4 block text-xs font-medium uppercase tracking-[0.06em] text-white/35">Preview Quality</label>
            <select
              className="mt-2 w-full rounded-xl border border-white/10 bg-[#111315] px-3 py-2 text-sm text-white outline-none"
              value={appPreferences.previewQualityPreset}
              onChange={(event) => setAppPreference("previewQualityPreset", event.target.value as PreviewQualityPreset)}
            >
              <option value="quality">Good quality</option>
              <option value="balanced">Balanced</option>
              <option value="speed">Fast speed</option>
            </select>
            <p className="mt-2 text-xs text-white/35">{previewPresetDescription} Incoming AirPlay bitrate and frame rate still follow the sender stream.</p>
            <label className="mt-3 flex items-center justify-between gap-4 text-sm text-white/80">
              <span>Use solid dark window background</span>
              <input
                type="checkbox"
                className="h-4 w-4 rounded border-white/15 bg-transparent"
                checked={appPreferences.useOpaqueWindowBackground}
                onChange={(event) => setAppPreference("useOpaqueWindowBackground", event.target.checked)}
              />
            </label>
            <p className="mt-2 text-xs text-white/35">Turn this on if you want the app window to use the current dark shell background instead of staying transparent.</p>
            <label className="mt-3 flex items-center justify-between gap-4 text-sm text-white/80">
              <span>Remember last view mode</span>
              <input
                type="checkbox"
                className="h-4 w-4 rounded border-white/15 bg-transparent"
                checked={appPreferences.rememberLastMode}
                onChange={(event) => setAppPreference("rememberLastMode", event.target.checked)}
              />
            </label>
            <label className="mt-3 flex items-center justify-between gap-4 text-sm text-white/80">
              <span>Remember last orientation</span>
              <input
                type="checkbox"
                className="h-4 w-4 rounded border-white/15 bg-transparent"
                checked={appPreferences.rememberLastOrientation}
                onChange={(event) => setAppPreference("rememberLastOrientation", event.target.checked)}
              />
            </label>
            <label className="mt-3 flex items-center justify-between gap-4 text-sm text-white/80">
              <span>Keep Minimal window always on top</span>
              <input
                type="checkbox"
                className="h-4 w-4 rounded border-white/15 bg-transparent"
                checked={appPreferences.keepMinimalOnTop}
                onChange={(event) => setAppPreference("keepMinimalOnTop", event.target.checked)}
              />
            </label>
          </div>

          <div className="rounded-2xl border border-white/8 bg-white/[0.03] p-4">
            <div className="text-[11px] font-semibold uppercase tracking-[0.08em] text-white/35">Captures</div>
            <label className="mt-3 flex items-center justify-between gap-4 text-sm text-white/80">
              <span>Save screenshots to disk</span>
              <input
                type="checkbox"
                className="h-4 w-4 rounded border-white/15 bg-transparent"
                checked={screenshotSettings.saveToDisk}
                onChange={(event) => setScreenshotSetting("saveToDisk", event.target.checked)}
              />
            </label>
            <label className="mt-3 flex items-center justify-between gap-4 text-sm text-white/80">
              <span>Copy screenshots to clipboard</span>
              <input
                type="checkbox"
                className="h-4 w-4 rounded border-white/15 bg-transparent"
                checked={screenshotSettings.copyToClipboard}
                onChange={(event) => setScreenshotSetting("copyToClipboard", event.target.checked)}
              />
            </label>
            {!screenshotSettings.saveToDisk && !screenshotSettings.copyToClipboard && (
              <p className="mt-3 text-xs text-amber-200/80">Turn on at least one action or screenshots will be blocked.</p>
            )}
            <label className="mt-3 flex items-center justify-between gap-4 text-sm text-white/80">
              <span>Reveal saved screenshots automatically</span>
              <input
                type="checkbox"
                className="h-4 w-4 rounded border-white/15 bg-transparent"
                checked={appPreferences.autoRevealSavedCaptures}
                onChange={(event) => setAppPreference("autoRevealSavedCaptures", event.target.checked)}
              />
            </label>
            <label className="mt-3 flex items-center justify-between gap-4 text-sm text-white/80">
              <span>Show screenshot flash animation</span>
              <input
                type="checkbox"
                className="h-4 w-4 rounded border-white/15 bg-transparent"
                checked={appPreferences.screenshotFlashEnabled}
                onChange={(event) => setAppPreference("screenshotFlashEnabled", event.target.checked)}
              />
            </label>
          </div>

          <div className="rounded-2xl border border-white/8 bg-white/[0.03] p-4">
            <div className="text-[11px] font-semibold uppercase tracking-[0.08em] text-white/35">Disk Save</div>
            <label className="mt-3 block text-xs font-medium uppercase tracking-[0.06em] text-white/35">Default Folder</label>
            <select
              className="mt-2 w-full rounded-xl border border-white/10 bg-[#111315] px-3 py-2 text-sm text-white outline-none"
              value={screenshotSettings.saveLocation}
              onChange={(event) => setScreenshotSetting("saveLocation", event.target.value as ScreenshotSaveLocation)}
            >
              <option value="pictures">Pictures/MirrorSim</option>
              <option value="documents">Documents/MirrorSim</option>
              <option value="downloads">Downloads/MirrorSim</option>
              <option value="custom">Custom folder</option>
            </select>

            {screenshotSettings.saveLocation === "custom" && (
              <>
                <label className="mt-4 block text-xs font-medium uppercase tracking-[0.06em] text-white/35">Custom Folder Path</label>
                <div className="mt-2 flex items-center gap-2">
                  <input
                    type="text"
                    className="min-w-0 flex-1 rounded-xl border border-white/10 bg-[#111315] px-3 py-2 text-sm text-white outline-none placeholder:text-white/20"
                    value={screenshotSettings.customSavePath}
                    onChange={(event) => setScreenshotSetting("customSavePath", event.target.value)}
                    placeholder="C:\\Users\\You\\Pictures\\MirrorSim"
                  />
                  <button
                    type="button"
                    className="inline-flex h-10 shrink-0 items-center justify-center rounded-xl border border-white/10 bg-white/6 px-3 text-sm font-medium text-white/80 transition hover:bg-white/10 hover:text-white"
                    onClick={onChooseScreenshotFolder}
                  >
                    Choose Folder
                  </button>
                </div>
                <p className="mt-2 text-xs text-white/35">MirrorSim will create the folder if it does not already exist.</p>
              </>
            )}

            <label className="mt-4 block text-xs font-medium uppercase tracking-[0.06em] text-white/35">File Prefix</label>
            <input
              type="text"
              className="mt-2 w-full rounded-xl border border-white/10 bg-[#111315] px-3 py-2 text-sm text-white outline-none placeholder:text-white/20"
              value={screenshotSettings.fileNamePrefix}
              onChange={(event) => setScreenshotSetting("fileNamePrefix", event.target.value)}
              placeholder="mirrorsim_screenshot"
            />

            <label className="mt-3 flex items-center justify-between gap-4 text-sm text-white/80">
              <span>Append timestamp to filename</span>
              <input
                type="checkbox"
                className="h-4 w-4 rounded border-white/15 bg-transparent"
                checked={screenshotSettings.includeTimestamp}
                onChange={(event) => setScreenshotSetting("includeTimestamp", event.target.checked)}
              />
            </label>
          </div>

          <div className="rounded-2xl border border-white/8 bg-white/[0.03] p-4">
            <div className="text-[11px] font-semibold uppercase tracking-[0.08em] text-white/35">Recordings</div>
            <label className="mt-3 block text-xs font-medium uppercase tracking-[0.06em] text-white/35">Default Folder</label>
            <select
              className="mt-2 w-full rounded-xl border border-white/10 bg-[#111315] px-3 py-2 text-sm text-white outline-none"
              value={recordingSettings.saveLocation}
              onChange={(event) => setRecordingSetting("saveLocation", event.target.value as ScreenshotSaveLocation)}
            >
              <option value="pictures">Pictures/MirrorSim</option>
              <option value="documents">Documents/MirrorSim</option>
              <option value="downloads">Downloads/MirrorSim</option>
              <option value="custom">Custom folder</option>
            </select>

            {recordingSettings.saveLocation === "custom" && (
              <>
                <label className="mt-4 block text-xs font-medium uppercase tracking-[0.06em] text-white/35">Custom Folder Path</label>
                <div className="mt-2 flex items-center gap-2">
                  <input
                    type="text"
                    className="min-w-0 flex-1 rounded-xl border border-white/10 bg-[#111315] px-3 py-2 text-sm text-white outline-none placeholder:text-white/20"
                    value={recordingSettings.customSavePath}
                    onChange={(event) => setRecordingSetting("customSavePath", event.target.value)}
                    placeholder="C:\\Users\\You\\Videos\\MirrorSim"
                  />
                  <button
                    type="button"
                    className="inline-flex h-10 shrink-0 items-center justify-center rounded-xl border border-white/10 bg-white/6 px-3 text-sm font-medium text-white/80 transition hover:bg-white/10 hover:text-white"
                    onClick={onChooseRecordingFolder}
                  >
                    Choose Folder
                  </button>
                </div>
                <p className="mt-2 text-xs text-white/35">MirrorSim will create the folder if it does not already exist.</p>
              </>
            )}

            <label className="mt-4 block text-xs font-medium uppercase tracking-[0.06em] text-white/35">File Prefix</label>
            <input
              type="text"
              className="mt-2 w-full rounded-xl border border-white/10 bg-[#111315] px-3 py-2 text-sm text-white outline-none placeholder:text-white/20"
              value={recordingSettings.fileNamePrefix}
              onChange={(event) => setRecordingSetting("fileNamePrefix", event.target.value)}
              placeholder="mirrorsim_recording"
            />

            <label className="mt-3 flex items-center justify-between gap-4 text-sm text-white/80">
              <span>Append timestamp to filename</span>
              <input
                type="checkbox"
                className="h-4 w-4 rounded border-white/15 bg-transparent"
                checked={recordingSettings.includeTimestamp}
                onChange={(event) => setRecordingSetting("includeTimestamp", event.target.checked)}
              />
            </label>

            <label className="mt-3 flex items-center justify-between gap-4 text-sm text-white/80">
              <span>Reveal saved recordings automatically</span>
              <input
                type="checkbox"
                className="h-4 w-4 rounded border-white/15 bg-transparent"
                checked={recordingSettings.autoReveal}
                onChange={(event) => setRecordingSetting("autoReveal", event.target.checked)}
              />
            </label>
            <p className="mt-2 text-xs text-white/35">MirrorSim records the live preview to a WebM file with the same framing you see in the app.</p>
            <div className="mt-3 rounded-xl border border-white/8 bg-black/15 px-3 py-2 text-xs leading-5 text-white/55">
              Preview quality is controlled from General. Saved screenshots always capture the full current frame, while live session bitrate and frame rate still come from the active AirPlay stream.
            </div>
          </div>

          <div className="rounded-2xl border border-white/8 bg-white/[0.03] p-4">
            <div className="text-[11px] font-semibold uppercase tracking-[0.08em] text-white/35">Connection</div>
            <label className="mt-3 flex items-center justify-between gap-4 text-sm text-white/80">
              <span>Auto-start device discovery on launch</span>
              <input
                type="checkbox"
                className="h-4 w-4 rounded border-white/15 bg-transparent"
                checked={appPreferences.autoStartDiscovery}
                onChange={(event) => setAppPreference("autoStartDiscovery", event.target.checked)}
              />
            </label>
            <p className="mt-2 text-xs text-white/35">When enabled, MirrorSim immediately begins discovery if it launches idle.</p>
            <label className="mt-3 flex items-center justify-between gap-4 text-sm text-white/80">
              <span>Auto-reconnect after connection drops</span>
              <input
                type="checkbox"
                className="h-4 w-4 rounded border-white/15 bg-transparent"
                checked={appPreferences.autoReconnectOnDrop}
                onChange={(event) => setAppPreference("autoReconnectOnDrop", event.target.checked)}
              />
            </label>
            <p className="mt-2 text-xs text-white/35">Retries reconnect automatically with short backoff after unexpected receiver disconnects or sidecar exits.</p>
          </div>

          <div className="rounded-2xl border border-white/8 bg-white/[0.03] p-4">
            <div className="text-[11px] font-semibold uppercase tracking-[0.08em] text-white/35">Advanced</div>
            <label className="mt-3 flex items-center justify-between gap-4 text-sm text-white/80">
              <span>Open diagnostics automatically on errors</span>
              <input
                type="checkbox"
                className="h-4 w-4 rounded border-white/15 bg-transparent"
                checked={appPreferences.openDiagnosticsOnError}
                onChange={(event) => setAppPreference("openDiagnosticsOnError", event.target.checked)}
              />
            </label>
            <p className="mt-2 text-xs text-white/35">Useful when debugging receiver or preview issues without manually opening the diagnostics panel.</p>
          </div>
        </div>
      </div>
    </div>
  );
}