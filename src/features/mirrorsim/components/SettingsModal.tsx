import { useEffect, useState } from "react";

import type {
  AppMode,
  AppPreferences,
  ConnectionHistoryEntry,
  DiagnosticsExport,
  PreviewQualityPreset,
  ReceiverAccessMode,
  RecordingSettings,
  ScreenshotSaveLocation,
  ScreenshotSettings,
  SessionSnapshot,
  TrustedDevice,
} from "@/features/mirrorsim/types";
import type { BonjourStatusSnapshot, ReceiverRuntimeSnapshot } from "@/receiverContract";

type SettingsModalProps = {
  open: boolean;
  appPreferences: AppPreferences;
  screenshotSettings: ScreenshotSettings;
  recordingSettings: RecordingSettings;
  session: SessionSnapshot;
  trustedDevices: TrustedDevice[];
  connectionHistory: ConnectionHistoryEntry[];
  bonjourStatus: BonjourStatusSnapshot;
  receiverRuntime: ReceiverRuntimeSnapshot;
  commandPending: boolean;
  receiverDisplayName: string;
  lastDiagnosticsExport: DiagnosticsExport | null;
  previewPresetDescription: string;
  onClose: () => void;
  setAppPreference: <K extends keyof AppPreferences>(key: K, value: AppPreferences[K]) => void;
  setScreenshotSetting: <K extends keyof ScreenshotSettings>(key: K, value: ScreenshotSettings[K]) => void;
  setRecordingSetting: <K extends keyof RecordingSettings>(key: K, value: RecordingSettings[K]) => void;
  onChooseScreenshotFolder: () => void;
  onChooseRecordingFolder: () => void;
  onTrustCurrentDevice: () => void;
  onForgetTrustedDevice: (deviceKey: string) => void;
  onRenameTrustedDevice: (deviceKey: string, nickname: string) => void;
  onSetTrustedDeviceBlocked: (deviceKey: string, blocked: boolean, reason?: string) => void;
  onResetTrustedDevices: () => void;
  onInstallBonjour: () => void;
  onRefreshBonjourStatus: () => void;
  onOpenWindowsServices: () => void;
  onOpenWindowsFirewall: () => void;
  onExportDiagnostics: () => void;
};

function Toggle({
  checked,
  onChange,
  disabled,
}: {
  checked: boolean;
  onChange: (value: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`relative inline-flex h-5.5 w-10.5 shrink-0 cursor-pointer rounded-full p-0.5 transition-colors duration-150 focus:outline-none disabled:cursor-default disabled:opacity-40 ${
        checked ? "bg-blue-500" : "bg-white/20"
      }`}
    >
      <span
        className={`h-4.5 w-4.5 transform rounded-full bg-white shadow-sm transition-transform duration-150 ${
          checked ? "translate-x-5" : "translate-x-0"
        }`}
      />
    </button>
  );
}

export function SettingsModal({
  open,
  appPreferences,
  screenshotSettings,
  recordingSettings,
  session,
  trustedDevices,
  connectionHistory,
  bonjourStatus,
  receiverRuntime,
  commandPending,
  receiverDisplayName,
  lastDiagnosticsExport,
  previewPresetDescription,
  onClose,
  setAppPreference,
  setScreenshotSetting,
  setRecordingSetting,
  onChooseScreenshotFolder,
  onChooseRecordingFolder,
  onTrustCurrentDevice,
  onForgetTrustedDevice,
  onRenameTrustedDevice,
  onSetTrustedDeviceBlocked,
  onResetTrustedDevices,
  onInstallBonjour,
  onRefreshBonjourStatus,
  onOpenWindowsServices,
  onOpenWindowsFirewall,
  onExportDiagnostics,
}: SettingsModalProps) {
  const [nicknameDrafts, setNicknameDrafts] = useState<Record<string, string>>({});
  const [blockReasonDrafts, setBlockReasonDrafts] = useState<Record<string, string>>({});

  useEffect(() => {
    const nextNicknames: Record<string, string> = {};
    const nextReasons: Record<string, string> = {};

    for (const device of trustedDevices) {
      nextNicknames[device.key] = device.nickname ?? "";
      nextReasons[device.key] = device.blockedReason ?? "";
    }

    setNicknameDrafts(nextNicknames);
    setBlockReasonDrafts(nextReasons);
  }, [trustedDevices]);

  if (!open) {
    return null;
  }

  const currentDeviceVisible = session.currentDeviceKey !== null;
  const hasTrustedDevices = trustedDevices.length > 0;
  const historyPreview = connectionHistory.slice(0, 8);
  const bonjourNeedsAttention = bonjourStatus.status === "missing" || bonjourStatus.status === "stopped";
  const receiverReady = receiverRuntime.state === "ready" || receiverRuntime.state === "streaming";
  const formatTimestamp = (timestamp: number | null | undefined) =>
    timestamp ? new Date(timestamp * 1000).toLocaleString() : "Never";
  const currentDeviceLabel = session.currentDeviceNickname ?? session.deviceName;
  const currentDeviceOsLabel = session.currentDeviceOsVersion
    ? `${session.currentDeviceOsName ?? "iPhone OS"} ${session.currentDeviceOsVersion}${session.currentDeviceOsBuildVersion ? ` (${session.currentDeviceOsBuildVersion})` : ""}`
    : session.currentDeviceOsName;

  function deviceHealthSummary(device: TrustedDevice) {
    if (device.isBlocked) {
      return device.blockedReason ? `Blocked: ${device.blockedReason}` : "Blocked on this PC";
    }
    if (device.pendingPairing) {
      return "Pairing or trust confirmation is pending";
    }
    if (device.lastFailureReason) {
      return `Last issue: ${device.lastFailureReason}`;
    }
    if (device.lastSuccessfulConnectionAt) {
      return `Last connected ${formatTimestamp(device.lastSuccessfulConnectionAt)}`;
    }
    return "Known device";
  }

  function deviceOsLabel(device: TrustedDevice) {
    return device.osVersion
      ? `${device.osName ?? "iPhone OS"} ${device.osVersion}${device.osBuildVersion ? ` (${device.osBuildVersion})` : ""}`
      : device.osName;
  }

  function deviceStatusTone(device: TrustedDevice) {
    if (device.isBlocked) {
      return "border-red-400/20 bg-red-500/10 text-red-200";
    }
    if (device.pendingPairing) {
      return "border-amber-400/20 bg-amber-500/10 text-amber-100";
    }
    if (device.trustedAt) {
      return "border-emerald-400/20 bg-emerald-500/10 text-emerald-200";
    }
    return "border-white/10 bg-white/6 text-white/70";
  }

  function historyStatusTone(status: string) {
    if (status === "error") {
      return "border-red-400/20 bg-red-500/10 text-red-200";
    }
    if (status === "warning") {
      return "border-amber-400/20 bg-amber-500/10 text-amber-100";
    }
    if (status === "success") {
      return "border-emerald-400/20 bg-emerald-500/10 text-emerald-200";
    }
    return "border-white/10 bg-white/6 text-white/70";
  }

  function capitalizeStatus(status: string) {
    return status.charAt(0).toUpperCase() + status.slice(1);
  }

  return (
    <div
      className="fixed inset-0 z-240 flex items-start justify-center overflow-y-auto bg-black/60 p-4 backdrop-blur-sm sm:items-center"
      onMouseDown={onClose}
    >
      <div
        className="flex max-h-[calc(100dvh-2rem)] w-full max-w-115 flex-col overflow-hidden rounded-[28px] border border-white/10 bg-[#17191d] p-5 shadow-[0_24px_72px_rgba(0,0,0,0.52)]"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-lg font-semibold tracking-[-0.02em] text-white">Preferences</h2>
            <p className="mt-1 text-sm text-white/45">Customize how MirrorSim looks, captures, and connects.</p>
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
          {/* General */}
          <div className="rounded-2xl border border-white/8 bg-white/3 p-4">
            <div className="text-[11px] font-semibold uppercase tracking-[0.08em] text-white/35">General</div>
            <label className="mt-3 block text-xs font-medium uppercase tracking-[0.06em] text-white/35">Default View</label>
            <select
              className="mt-2 w-full rounded-xl border border-white/10 bg-[#111315] px-3 py-2 text-sm text-white outline-none"
              value={appPreferences.launchMode}
              onChange={(event) => setAppPreference("launchMode", event.target.value as AppMode)}
            >
              <option value="console">Console — full view with controls</option>
              <option value="minimal">Minimal — compact overlay</option>
            </select>
            <label className="mt-4 block text-xs font-medium uppercase tracking-[0.06em] text-white/35">Preview Quality</label>
            <select
              className="mt-2 w-full rounded-xl border border-white/10 bg-[#111315] px-3 py-2 text-sm text-white outline-none"
              value={appPreferences.previewQualityPreset}
              onChange={(event) => setAppPreference("previewQualityPreset", event.target.value as PreviewQualityPreset)}
            >
              <option value="quality">High quality</option>
              <option value="balanced">Balanced</option>
              <option value="speed">Fast</option>
            </select>
            <p className="mt-2 text-xs text-white/35">{previewPresetDescription} This only affects what you see in the app — your iPhone's actual stream quality is unchanged.</p>
            <label className="mt-4 block text-xs font-medium uppercase tracking-[0.06em] text-white/35">AirPlay Receiver Name</label>
            <input
              type="text"
              className="mt-2 w-full rounded-xl border border-white/10 bg-[#111315] px-3 py-2 text-sm text-white outline-none placeholder:text-white/20"
              value={receiverDisplayName}
              onChange={(event) => setAppPreference("receiverDisplayName", event.target.value)}
              placeholder="MirrorSim"
            />
            <p className="mt-2 text-xs text-white/35">This is what appears in your iPhone's Screen Mirroring list. Keep it short and recognizable.</p>
            <div className="mt-4 flex items-center justify-between gap-4">
              <div>
                <div className="text-sm text-white/80">Solid window background</div>
                <div className="mt-0.5 text-xs text-white/40">Uses an opaque dark background instead of transparent glass.</div>
              </div>
              <Toggle
                checked={appPreferences.useOpaqueWindowBackground}
                onChange={(value) => setAppPreference("useOpaqueWindowBackground", value)}
              />
            </div>
            <div className="mt-4 flex items-center justify-between gap-4">
              <span className="text-sm text-white/80">Remember last view mode</span>
              <Toggle
                checked={appPreferences.rememberLastMode}
                onChange={(value) => setAppPreference("rememberLastMode", value)}
              />
            </div>
            <div className="mt-4 flex items-center justify-between gap-4">
              <span className="text-sm text-white/80">Remember last orientation</span>
              <Toggle
                checked={appPreferences.rememberLastOrientation}
                onChange={(value) => setAppPreference("rememberLastOrientation", value)}
              />
            </div>
            <div className="mt-4 flex items-center justify-between gap-4">
              <span className="text-sm text-white/80">Keep Minimal window always on top</span>
              <Toggle
                checked={appPreferences.keepMinimalOnTop}
                onChange={(value) => setAppPreference("keepMinimalOnTop", value)}
              />
            </div>
          </div>

          {/* Screenshots */}
          <div className="rounded-2xl border border-white/8 bg-white/3 p-4">
            <div className="text-[11px] font-semibold uppercase tracking-[0.08em] text-white/35">Screenshots</div>
            <div className="mt-3 flex items-center justify-between gap-4">
              <span className="text-sm text-white/80">Save screenshots to disk</span>
              <Toggle
                checked={screenshotSettings.saveToDisk}
                onChange={(value) => setScreenshotSetting("saveToDisk", value)}
              />
            </div>
            <div className="mt-4 flex items-center justify-between gap-4">
              <span className="text-sm text-white/80">Copy to clipboard</span>
              <Toggle
                checked={screenshotSettings.copyToClipboard}
                onChange={(value) => setScreenshotSetting("copyToClipboard", value)}
              />
            </div>
            {!screenshotSettings.saveToDisk && !screenshotSettings.copyToClipboard && (
              <p className="mt-3 text-xs text-amber-200/80">Enable at least one action, or screenshots won't go anywhere.</p>
            )}
            <div className="mt-4 flex items-center justify-between gap-4">
              <div>
                <div className="text-sm text-white/80">Open in Explorer after saving</div>
                <div className="mt-0.5 text-xs text-white/40">Reveals the file in File Explorer each time a screenshot is saved.</div>
              </div>
              <Toggle
                checked={appPreferences.autoRevealSavedCaptures}
                onChange={(value) => setAppPreference("autoRevealSavedCaptures", value)}
              />
            </div>
            <div className="mt-4 flex items-center justify-between gap-4">
              <span className="text-sm text-white/80">Show capture flash animation</span>
              <Toggle
                checked={appPreferences.screenshotFlashEnabled}
                onChange={(value) => setAppPreference("screenshotFlashEnabled", value)}
              />
            </div>
          </div>

          {/* Screenshot Folder */}
          <div className="rounded-2xl border border-white/8 bg-white/3 p-4">
            <div className="text-[11px] font-semibold uppercase tracking-[0.08em] text-white/35">Screenshot Folder</div>
            <label className="mt-3 block text-xs font-medium uppercase tracking-[0.06em] text-white/35">Save To</label>
            <select
              className="mt-2 w-full rounded-xl border border-white/10 bg-[#111315] px-3 py-2 text-sm text-white outline-none"
              value={screenshotSettings.saveLocation}
              onChange={(event) => setScreenshotSetting("saveLocation", event.target.value as ScreenshotSaveLocation)}
            >
              <option value="pictures">Pictures / MirrorSim</option>
              <option value="documents">Documents / MirrorSim</option>
              <option value="downloads">Downloads / MirrorSim</option>
              <option value="custom">Custom folder…</option>
            </select>

            {screenshotSettings.saveLocation === "custom" && (
              <>
                <label className="mt-4 block text-xs font-medium uppercase tracking-[0.06em] text-white/35">Folder Path</label>
                <div className="mt-2 flex items-center gap-2">
                  <input
                    type="text"
                    className="min-w-0 flex-1 rounded-xl border border-white/10 bg-[#111315] px-3 py-2 text-sm text-white outline-none placeholder:text-white/20"
                    value={screenshotSettings.customSavePath}
                    onChange={(event) => setScreenshotSetting("customSavePath", event.target.value)}
                    placeholder="C:\Users\You\Pictures\MirrorSim"
                  />
                  <button
                    type="button"
                    className="inline-flex h-10 shrink-0 items-center justify-center rounded-xl border border-white/10 bg-white/6 px-3 text-sm font-medium text-white/80 transition hover:bg-white/10 hover:text-white"
                    onClick={onChooseScreenshotFolder}
                  >
                    Browse
                  </button>
                </div>
                <p className="mt-2 text-xs text-white/35">The folder will be created automatically if it doesn't exist.</p>
              </>
            )}

            <label className="mt-4 block text-xs font-medium uppercase tracking-[0.06em] text-white/35">Filename Prefix</label>
            <input
              type="text"
              className="mt-2 w-full rounded-xl border border-white/10 bg-[#111315] px-3 py-2 text-sm text-white outline-none placeholder:text-white/20"
              value={screenshotSettings.fileNamePrefix}
              onChange={(event) => setScreenshotSetting("fileNamePrefix", event.target.value)}
              placeholder="mirrorsim_screenshot"
            />

            <div className="mt-4 flex items-center justify-between gap-4">
              <span className="text-sm text-white/80">Append timestamp to filename</span>
              <Toggle
                checked={screenshotSettings.includeTimestamp}
                onChange={(value) => setScreenshotSetting("includeTimestamp", value)}
              />
            </div>
          </div>

          {/* Recordings */}
          <div className="rounded-2xl border border-white/8 bg-white/3 p-4">
            <div className="text-[11px] font-semibold uppercase tracking-[0.08em] text-white/35">Recordings</div>
            <label className="mt-3 block text-xs font-medium uppercase tracking-[0.06em] text-white/35">Save To</label>
            <select
              className="mt-2 w-full rounded-xl border border-white/10 bg-[#111315] px-3 py-2 text-sm text-white outline-none"
              value={recordingSettings.saveLocation}
              onChange={(event) => setRecordingSetting("saveLocation", event.target.value as ScreenshotSaveLocation)}
            >
              <option value="pictures">Pictures / MirrorSim</option>
              <option value="documents">Documents / MirrorSim</option>
              <option value="downloads">Downloads / MirrorSim</option>
              <option value="custom">Custom folder…</option>
            </select>

            {recordingSettings.saveLocation === "custom" && (
              <>
                <label className="mt-4 block text-xs font-medium uppercase tracking-[0.06em] text-white/35">Folder Path</label>
                <div className="mt-2 flex items-center gap-2">
                  <input
                    type="text"
                    className="min-w-0 flex-1 rounded-xl border border-white/10 bg-[#111315] px-3 py-2 text-sm text-white outline-none placeholder:text-white/20"
                    value={recordingSettings.customSavePath}
                    onChange={(event) => setRecordingSetting("customSavePath", event.target.value)}
                    placeholder="C:\Users\You\Videos\MirrorSim"
                  />
                  <button
                    type="button"
                    className="inline-flex h-10 shrink-0 items-center justify-center rounded-xl border border-white/10 bg-white/6 px-3 text-sm font-medium text-white/80 transition hover:bg-white/10 hover:text-white"
                    onClick={onChooseRecordingFolder}
                  >
                    Browse
                  </button>
                </div>
                <p className="mt-2 text-xs text-white/35">The folder will be created automatically if it doesn't exist.</p>
              </>
            )}

            <label className="mt-4 block text-xs font-medium uppercase tracking-[0.06em] text-white/35">Filename Prefix</label>
            <input
              type="text"
              className="mt-2 w-full rounded-xl border border-white/10 bg-[#111315] px-3 py-2 text-sm text-white outline-none placeholder:text-white/20"
              value={recordingSettings.fileNamePrefix}
              onChange={(event) => setRecordingSetting("fileNamePrefix", event.target.value)}
              placeholder="mirrorsim_recording"
            />

            <div className="mt-4 flex items-center justify-between gap-4">
              <span className="text-sm text-white/80">Append timestamp to filename</span>
              <Toggle
                checked={recordingSettings.includeTimestamp}
                onChange={(value) => setRecordingSetting("includeTimestamp", value)}
              />
            </div>

            <div className="mt-4 flex items-center justify-between gap-4">
              <div>
                <div className="text-sm text-white/80">Open in Explorer after saving</div>
                <div className="mt-0.5 text-xs text-white/40">Reveals the file in File Explorer when a recording finishes.</div>
              </div>
              <Toggle
                checked={recordingSettings.autoReveal}
                onChange={(value) => setRecordingSetting("autoReveal", value)}
              />
            </div>
            <div className="mt-3 rounded-xl border border-white/8 bg-black/15 px-3 py-2 text-xs leading-5 text-white/55">
              Screenshots always save the full current frame. Recording quality follows your Preview Quality setting in General.
            </div>
          </div>

          {/* Connection */}
          <div className="rounded-2xl border border-white/8 bg-white/3 p-4">
            <div className="text-[11px] font-semibold uppercase tracking-[0.08em] text-white/35">Connection</div>
            <div className="mt-3 flex items-center justify-between gap-4">
              <div>
                <div className="text-sm text-white/80">Search for devices on launch</div>
                <div className="mt-0.5 text-xs text-white/40">MirrorSim will look for your iPhone as soon as it opens.</div>
              </div>
              <Toggle
                checked={appPreferences.autoStartDiscovery}
                onChange={(value) => setAppPreference("autoStartDiscovery", value)}
              />
            </div>
            <div className="mt-4 flex items-center justify-between gap-4">
              <div>
                <div className="text-sm text-white/80">Auto-reconnect after connection drops</div>
                <div className="mt-0.5 text-xs text-white/40">If the connection drops unexpectedly, MirrorSim will try to reconnect on its own.</div>
              </div>
              <Toggle
                checked={appPreferences.autoReconnectOnDrop}
                onChange={(value) => setAppPreference("autoReconnectOnDrop", value)}
              />
            </div>
          </div>

          {/* Network & Discovery */}
          <div className="rounded-2xl border border-white/8 bg-white/3 p-4">
            <div className="flex items-center justify-between gap-3">
              <div className="text-[11px] font-semibold uppercase tracking-[0.08em] text-white/35">Network & Discovery</div>
              <span className={`inline-flex items-center rounded-full border px-2.5 py-1 text-[11px] font-medium ${bonjourNeedsAttention ? "border-amber-400/20 bg-amber-500/10 text-amber-100" : "border-emerald-400/20 bg-emerald-500/10 text-emerald-200"}`}>
                {bonjourNeedsAttention ? "Needs attention" : "Ready"}
              </span>
            </div>
            <div className="mt-3 rounded-xl border border-white/8 bg-black/15 p-3 text-xs leading-5 text-white/60">
              <div><span className="text-white/35">Bonjour:</span> {bonjourStatus.detail}</div>
              <div className="mt-1"><span className="text-white/35">Receiver:</span> {receiverReady ? "Listening for devices" : receiverRuntime.lastError ?? "Starting up"}</div>
              <div className="mt-1"><span className="text-white/35">Visible to iPhone as:</span> {receiverDisplayName}</div>
            </div>
            <div className="mt-3 flex flex-wrap gap-2">
              <button
                type="button"
                className="inline-flex items-center rounded-lg border border-white/10 bg-white/6 px-3 py-1.5 text-[11px] font-medium text-white/80 transition hover:bg-white/10 hover:text-white"
                onClick={onRefreshBonjourStatus}
                disabled={commandPending}
              >
                Recheck Bonjour
              </button>
              <button
                type="button"
                className="inline-flex items-center rounded-lg border border-white/10 bg-white/6 px-3 py-1.5 text-[11px] font-medium text-white/80 transition hover:bg-white/10 hover:text-white"
                onClick={onOpenWindowsServices}
              >
                Windows Services
              </button>
              <button
                type="button"
                className="inline-flex items-center rounded-lg border border-white/10 bg-white/6 px-3 py-1.5 text-[11px] font-medium text-white/80 transition hover:bg-white/10 hover:text-white"
                onClick={onOpenWindowsFirewall}
              >
                Windows Firewall
              </button>
              <button
                type="button"
                className="inline-flex items-center rounded-lg border border-white/10 bg-white/6 px-3 py-1.5 text-[11px] font-medium text-white/80 transition hover:bg-white/10 hover:text-white"
                onClick={onInstallBonjour}
              >
                Install Bonjour
              </button>
            </div>
            <ol className="mt-3 space-y-1 text-xs leading-5 text-white/45">
              <li>1. Keep MirrorSim open and running.</li>
              <li>2. On your iPhone, open Control Center and tap Screen Mirroring.</li>
              <li>3. Look for <strong className="text-white/60">{receiverDisplayName}</strong> on the same Wi-Fi network.</li>
              <li>4. Not showing up? Use Recheck Bonjour and make sure Windows Firewall isn't blocking MirrorSim.</li>
            </ol>
          </div>

          {/* Device Trust */}
          <div className="rounded-2xl border border-white/8 bg-white/3 p-4">
            <div className="flex items-center justify-between gap-3">
              <div className="text-[11px] font-semibold uppercase tracking-[0.08em] text-white/35">Device Trust</div>
              {hasTrustedDevices && (
                <button
                  type="button"
                  className="inline-flex items-center rounded-lg border border-white/10 bg-white/6 px-2.5 py-1 text-[11px] font-medium text-white/70 transition hover:bg-white/10 hover:text-white disabled:cursor-default disabled:opacity-40"
                  onClick={onResetTrustedDevices}
                  disabled={commandPending}
                >
                  Reset All
                </button>
              )}
            </div>

            <label className="mt-3 block text-xs font-medium uppercase tracking-[0.06em] text-white/35">When a new iPhone connects</label>
            <select
              className="mt-2 w-full rounded-xl border border-white/10 bg-[#111315] px-3 py-2 text-sm text-white outline-none"
              value={appPreferences.receiverAccessMode}
              onChange={(event) => setAppPreference("receiverAccessMode", event.target.value as ReceiverAccessMode)}
            >
              <option value="remember-trusted">Remember approved iPhones on this PC</option>
              <option value="ask">Ask each time — don't remember</option>
            </select>
            <p className="mt-2 text-xs leading-5 text-white/40">
              {appPreferences.receiverAccessMode === "remember-trusted"
                ? "Approving a device adds it to this PC's trusted list so it can reconnect automatically next time."
                : "Each new connection requires approval. MirrorSim won't remember the device unless you save it manually."}
            </p>

            {currentDeviceVisible ? (
              <div className="mt-3 rounded-xl border border-white/8 bg-black/15 p-3">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <div className="text-sm font-medium text-white/90">{currentDeviceLabel}</div>
                    <div className="mt-1 text-xs text-white/40">
                      {session.currentDeviceBlocked
                        ? session.currentDeviceBlockedReason ?? "This iPhone is blocked on this PC."
                        : session.currentDeviceTrusted
                        ? "This iPhone is already remembered on this PC."
                        : appPreferences.receiverAccessMode === "remember-trusted"
                          ? "Connected, but not saved to the trusted list yet."
                          : "Connected for this session only. MirrorSim will ask again next time unless you save it."}
                    </div>
                    {(session.currentDeviceModel || currentDeviceOsLabel || session.currentDeviceSourceVersion) && (
                      <div className="mt-2 text-[11px] leading-5 text-white/38">
                        {session.currentDeviceModel ? `Model: ${session.currentDeviceModel}` : ""}
                        {session.currentDeviceModel && currentDeviceOsLabel ? " · " : ""}
                        {currentDeviceOsLabel ? `OS: ${currentDeviceOsLabel}` : ""}
                        {(session.currentDeviceModel || currentDeviceOsLabel) && session.currentDeviceSourceVersion ? " · " : ""}
                        {session.currentDeviceSourceVersion ? `AirPlay: ${session.currentDeviceSourceVersion}` : ""}
                      </div>
                    )}
                  </div>
                  {session.currentDeviceBlocked ? (
                    <span className="inline-flex items-center rounded-full border border-red-400/20 bg-red-500/10 px-2.5 py-1 text-[11px] font-medium text-red-200">
                      Blocked
                    </span>
                  ) : session.currentDeviceTrusted ? (
                    <span className="inline-flex items-center rounded-full border border-emerald-400/20 bg-emerald-500/10 px-2.5 py-1 text-[11px] font-medium text-emerald-200">
                      Trusted
                    </span>
                  ) : (
                    <button
                      type="button"
                      className="inline-flex items-center rounded-lg border border-white/10 bg-white/6 px-3 py-1.5 text-[11px] font-medium text-white/80 transition hover:bg-white/10 hover:text-white disabled:cursor-default disabled:opacity-40"
                      onClick={onTrustCurrentDevice}
                      disabled={commandPending}
                    >
                      Remember This iPhone
                    </button>
                  )}
                </div>
              </div>
            ) : (
              <p className="mt-3 text-xs leading-5 text-white/40">No iPhone is connected. Once one connects and you approve it, it will appear here.</p>
            )}

            {hasTrustedDevices ? (
              <div className="mt-3 space-y-2">
                {trustedDevices.map((device) => (
                  <div key={device.key} className="rounded-xl border border-white/8 bg-black/15 px-3 py-3">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <div className="truncate text-sm font-medium text-white/88">{device.nickname ?? device.displayName}</div>
                          <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-medium ${deviceStatusTone(device)}`}>
                            {device.isBlocked ? "Blocked" : device.pendingPairing ? "Pending" : device.trustedAt ? "Trusted" : "Known"}
                          </span>
                        </div>
                        <div className="mt-1 text-[11px] leading-4 text-white/38">{deviceHealthSummary(device)}</div>
                        {(device.model || deviceOsLabel(device) || device.sourceVersion) && (
                          <div className="mt-1 text-[11px] leading-4 text-white/38">
                            {device.model ? `Model: ${device.model}` : ""}
                            {device.model && deviceOsLabel(device) ? " · " : ""}
                            {deviceOsLabel(device) ? `OS: ${deviceOsLabel(device)}` : ""}
                            {(device.model || deviceOsLabel(device)) && device.sourceVersion ? " · " : ""}
                            {device.sourceVersion ? `AirPlay: ${device.sourceVersion}` : ""}
                          </div>
                        )}
                        <div className="mt-2 grid gap-1 text-[11px] leading-4 text-white/35 sm:grid-cols-2">
                          <div>First seen: {formatTimestamp(device.firstSeenAt)}</div>
                          <div>Last seen: {formatTimestamp(device.lastSeenAt)}</div>
                          <div>Last successful: {formatTimestamp(device.lastSuccessfulConnectionAt)}</div>
                          <div>Last pairing: {formatTimestamp(device.lastPairingAt)}</div>
                        </div>
                      </div>
                      <button
                        type="button"
                        className="inline-flex items-center rounded-lg border border-white/10 bg-white/6 px-2.5 py-1 text-[11px] font-medium text-white/70 transition hover:bg-white/10 hover:text-white disabled:cursor-default disabled:opacity-40"
                        onClick={() => onForgetTrustedDevice(device.key)}
                        disabled={commandPending}
                      >
                        Forget
                      </button>
                    </div>

                    <div className="mt-3 grid gap-2 sm:grid-cols-[1fr_auto]">
                      <input
                        type="text"
                        className="rounded-xl border border-white/10 bg-[#111315] px-3 py-2 text-sm text-white outline-none placeholder:text-white/20"
                        value={nicknameDrafts[device.key] ?? ""}
                        onChange={(event) => setNicknameDrafts((previous) => ({ ...previous, [device.key]: event.target.value }))}
                        placeholder="Give this iPhone a nickname"
                      />
                      <button
                        type="button"
                        className="inline-flex items-center justify-center rounded-xl border border-white/10 bg-white/6 px-3 py-2 text-sm font-medium text-white/80 transition hover:bg-white/10 hover:text-white disabled:cursor-default disabled:opacity-40"
                        onClick={() => onRenameTrustedDevice(device.key, nicknameDrafts[device.key] ?? "")}
                        disabled={commandPending}
                      >
                        Save
                      </button>
                    </div>

                    <div className="mt-2 grid gap-2 sm:grid-cols-[1fr_auto_auto]">
                      <input
                        type="text"
                        className="rounded-xl border border-white/10 bg-[#111315] px-3 py-2 text-sm text-white outline-none placeholder:text-white/20"
                        value={blockReasonDrafts[device.key] ?? ""}
                        onChange={(event) => setBlockReasonDrafts((previous) => ({ ...previous, [device.key]: event.target.value }))}
                        placeholder="Block reason (optional)"
                      />
                      <button
                        type="button"
                        className="inline-flex items-center justify-center rounded-xl border border-red-400/20 bg-red-500/10 px-3 py-2 text-sm font-medium text-red-200 transition hover:bg-red-500/15 disabled:cursor-default disabled:opacity-40"
                        onClick={() => onSetTrustedDeviceBlocked(device.key, true, blockReasonDrafts[device.key])}
                        disabled={commandPending || device.isBlocked}
                      >
                        Block
                      </button>
                      <button
                        type="button"
                        className="inline-flex items-center justify-center rounded-xl border border-white/10 bg-white/6 px-3 py-2 text-sm font-medium text-white/80 transition hover:bg-white/10 hover:text-white disabled:cursor-default disabled:opacity-40"
                        onClick={() => onSetTrustedDeviceBlocked(device.key, false)}
                        disabled={commandPending || !device.isBlocked}
                      >
                        Unblock
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <p className="mt-3 text-xs text-white/35">No remembered devices yet. Connect an iPhone and approve it to add it here.</p>
            )}
          </div>

          {/* Diagnostics */}
          <div className="rounded-2xl border border-white/8 bg-white/3 p-4">
            <div className="flex items-center justify-between gap-3">
              <div>
                <div className="text-[11px] font-semibold uppercase tracking-[0.08em] text-white/35">Diagnostics</div>
                <p className="mt-1 text-xs text-white/40">Connection history and exportable logs for support or debugging.</p>
              </div>
              <button
                type="button"
                className="inline-flex items-center rounded-lg border border-white/10 bg-white/6 px-3 py-1.5 text-[11px] font-medium text-white/80 transition hover:bg-white/10 hover:text-white disabled:cursor-default disabled:opacity-40"
                onClick={onExportDiagnostics}
                disabled={commandPending}
              >
                Export Diagnostics
              </button>
            </div>
            {lastDiagnosticsExport && (
              <div className="mt-3 rounded-xl border border-white/8 bg-black/15 px-3 py-2 text-xs leading-5 text-white/55">
                Last export: {lastDiagnosticsExport.fileName} — {lastDiagnosticsExport.entryCount} entries at {formatTimestamp(lastDiagnosticsExport.exportedAt)}.
              </div>
            )}
            {historyPreview.length > 0 ? (
              <div className="mt-3 space-y-2">
                {historyPreview.map((entry) => (
                  <div key={entry.id} className="rounded-xl border border-white/8 bg-black/15 px-3 py-2.5">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-sm font-medium text-white/88">{entry.message}</div>
                        <div className="mt-1 text-[11px] leading-4 text-white/38">
                          {formatTimestamp(entry.occurredAt)}
                          {entry.deviceName ? ` · ${entry.deviceName}` : ""}
                          {entry.deviceModel ? ` · ${entry.deviceModel}` : ""}
                          {entry.deviceOsVersion ? ` · ${entry.deviceOsName ?? "iPhone OS"} ${entry.deviceOsVersion}` : entry.deviceOsName ? ` · ${entry.deviceOsName}` : ""}
                          {entry.receiverName ? ` · ${entry.receiverName}` : ""}
                        </div>
                      </div>
                      <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-medium ${historyStatusTone(entry.status)}`}>
                        {capitalizeStatus(entry.status)}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <p className="mt-3 text-xs text-white/35">No connection history yet.</p>
            )}
          </div>

          {/* Advanced */}
          <div className="rounded-2xl border border-white/8 bg-white/3 p-4">
            <div className="text-[11px] font-semibold uppercase tracking-[0.08em] text-white/35">Advanced</div>
            <div className="mt-3 flex items-center justify-between gap-4">
              <div>
                <div className="text-sm text-white/80">Auto-open diagnostics on errors</div>
                <div className="mt-0.5 text-xs text-white/40">Useful when debugging receiver or preview issues without manually opening the diagnostics panel.</div>
              </div>
              <Toggle
                checked={appPreferences.openDiagnosticsOnError}
                onChange={(value) => setAppPreference("openDiagnosticsOnError", value)}
              />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
