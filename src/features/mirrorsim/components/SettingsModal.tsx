import { useEffect, useRef, useState } from "react";

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
import { useModalFocus } from "@/features/mirrorsim/hooks/useModalFocus";

type SettingsModalProps = {
  open: boolean;
  embedded?: boolean;
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
  appVersion: string;
  updateStatus: string;
  updateError: string | null;
  audioAvailable: boolean;
  audioStatus: string;
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
  onCheckForUpdates: () => void;
  onOpenProject: () => void;
  onOpenIssues: () => void;
  onOpenLicense: () => void;
  onOpenThirdPartyNotices: () => void;
};

type SettingsSection = "general" | "capture" | "connection" | "devices" | "support";

const settingsSections: Array<{ id: SettingsSection; label: string }> = [
  { id: "general", label: "General" },
  { id: "capture", label: "Capture" },
  { id: "connection", label: "Connection" },
  { id: "devices", label: "Devices" },
  { id: "support", label: "Support" },
];

function Toggle({
  checked,
  onChange,
  disabled,
  label,
}: {
  checked: boolean;
  onChange: (value: boolean) => void;
  disabled?: boolean;
  label: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`relative inline-flex h-5.5 w-10.5 shrink-0 cursor-pointer rounded-full p-0.5 transition-colors duration-150 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-400 disabled:cursor-default disabled:opacity-40 ${
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

const fieldLabel = "mb-1.5 text-[11px] text-white/45";
const fieldInput = "w-full rounded-xl border border-white/8 bg-[#111315] px-3 py-2 text-sm text-white/85 outline-none placeholder:text-white/22 focus-visible:border-blue-400/60 focus-visible:ring-2 focus-visible:ring-blue-400/30 disabled:cursor-not-allowed disabled:opacity-45";
const fieldNote = "mt-1.5 text-[11px] leading-4 text-white/38";
const btn = "rounded-xl border border-white/8 bg-white/5 px-3 py-1.5 text-[11px] font-medium text-white/75 transition hover:border-white/14 hover:bg-white/10 hover:text-white disabled:cursor-default disabled:opacity-40";
const btnSm = "rounded-xl border border-white/8 bg-white/5 px-2.5 py-1 text-[10px] font-medium text-white/65 transition hover:border-white/14 hover:bg-white/10 hover:text-white disabled:cursor-default disabled:opacity-40";
const btnDestructive = "rounded-xl border border-red-400/20 bg-red-500/10 px-3 py-1.5 text-[11px] font-medium text-red-300 transition hover:bg-red-500/15 disabled:cursor-default disabled:opacity-40";
const sectionHeader = "text-[10px] font-semibold uppercase tracking-[0.08em] text-white/28";
const infoBox = "rounded-xl border border-white/7 bg-[#111315] p-3 text-[11px] leading-5 text-white/55";

export function SettingsModal({
  open,
  embedded = false,
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
  appVersion,
  updateStatus,
  updateError,
  audioAvailable,
  audioStatus,
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
  onCheckForUpdates,
  onOpenProject,
  onOpenIssues,
  onOpenLicense,
  onOpenThirdPartyNotices,
}: SettingsModalProps) {
  const [activeSection, setActiveSection] = useState<SettingsSection>("general");
  const [nicknameDrafts, setNicknameDrafts] = useState<Record<string, string>>({});
  const [blockReasonDrafts, setBlockReasonDrafts] = useState<Record<string, string>>({});
  const [pendingConfirmation, setPendingConfirmation] = useState<string | null>(null);
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);
  const dialogRef = useModalFocus(open, onClose, closeButtonRef);

  useEffect(() => {
    const nextNicknames: Record<string, string> = {};
    const nextReasons: Record<string, string> = {};

    for (const device of trustedDevices) {
      nextNicknames[device.key] = device.nickname ?? "";
      nextReasons[device.key] = device.blockedReason ?? "";
    }

    setNicknameDrafts(nextNicknames);
    setBlockReasonDrafts(nextReasons);
    setPendingConfirmation(null);
  }, [trustedDevices]);

  useEffect(() => {
    if (open) {
      setActiveSection("general");
    }
  }, [open]);

  useEffect(() => {
    if (!pendingConfirmation) return;
    const timeout = window.setTimeout(() => setPendingConfirmation(null), 5_000);
    return () => window.clearTimeout(timeout);
  }, [pendingConfirmation]);

  if (!open) {
    return null;
  }

  const currentDeviceVisible = session.currentDeviceKey !== null;
  const hasTrustedDevices = trustedDevices.length > 0;
  const historyPreview = connectionHistory.slice(0, 8);
  const bonjourNeedsAttention = bonjourStatus.status === "missing" || bonjourStatus.status === "stopped";
  const receiverReady = receiverRuntime.state === "ready" || receiverRuntime.state === "streaming";
  const sessionActive = session.status !== "idle";
  const formatTimestamp = (timestamp: number | null | undefined) =>
    timestamp ? new Date(timestamp * 1000).toLocaleString() : "Never";
  const currentDeviceLabel = session.currentDeviceNickname ?? session.deviceName;
  const currentDeviceOsLabel = session.currentDeviceOsVersion
    ? `${session.currentDeviceOsName ?? "iPhone OS"} ${session.currentDeviceOsVersion}${session.currentDeviceOsBuildVersion ? ` (${session.currentDeviceOsBuildVersion})` : ""}`
    : session.currentDeviceOsName;

  function deviceIdSuffix(deviceId: string | null | undefined) {
    const normalized = deviceId?.replace(/[^a-z0-9]/gi, "").toUpperCase();
    if (!normalized) {
      return null;
    }

    return normalized.slice(-6);
  }

  function currentDeviceHoverDetails() {
    return [
      session.currentDeviceModel ? `Model: ${session.currentDeviceModel}` : null,
      currentDeviceOsLabel ? `OS: ${currentDeviceOsLabel}` : null,
      session.currentDeviceId ? `Device ID ending in ${deviceIdSuffix(session.currentDeviceId)}` : null,
      session.currentDeviceSourceVersion ? `AirPlay: ${session.currentDeviceSourceVersion}` : null,
      session.currentDeviceTrusted
        ? "Status: Trusted"
        : session.currentDeviceBlocked
          ? "Status: Blocked"
          : "Status: Current session device"
    ].filter(Boolean) as string[];
  }

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

  function trustedDeviceHoverDetails(device: TrustedDevice) {
    const details = [
      device.model ? `Model: ${device.model}` : null,
      deviceOsLabel(device) ? `OS: ${deviceOsLabel(device)}` : null,
      device.deviceId ? `Device ID ending in ${deviceIdSuffix(device.deviceId)}` : null,
      device.sourceVersion ? `AirPlay: ${device.sourceVersion}` : null,
      `Last seen: ${formatTimestamp(device.lastSeenAt)}`,
      device.lastSuccessfulConnectionAt ? `Last successful: ${formatTimestamp(device.lastSuccessfulConnectionAt)}` : null,
      device.isBlocked ? "Status: Blocked" : device.trustedAt ? "Status: Trusted" : "Status: Known",
    ];

    return details.filter(Boolean) as string[];
  }

  function deviceStatusTone(device: TrustedDevice) {
    if (device.isBlocked) {
      return "border-red-400/20 bg-red-500/10 text-red-300";
    }
    if (device.pendingPairing) {
      return "border-amber-400/20 bg-amber-500/10 text-amber-200";
    }
    if (device.trustedAt) {
      return "border-emerald-400/20 bg-emerald-500/10 text-emerald-300";
    }
    return "border-white/8 bg-white/5 text-white/65";
  }

  function historyStatusTone(status: string) {
    if (status === "error") {
      return "border-red-400/20 bg-red-500/10 text-red-300";
    }
    if (status === "warning") {
      return "border-amber-400/20 bg-amber-500/10 text-amber-200";
    }
    if (status === "success") {
      return "border-emerald-400/20 bg-emerald-500/10 text-emerald-300";
    }
    return "border-white/8 bg-white/5 text-white/65";
  }

  function capitalizeStatus(status: string) {
    return status.charAt(0).toUpperCase() + status.slice(1);
  }

  function confirmDestructiveAction(key: string, action: () => void) {
    if (pendingConfirmation === key) {
      setPendingConfirmation(null);
      action();
    } else {
      setPendingConfirmation(key);
    }
  }

  return (
    <div
      className={embedded
        ? "absolute inset-0 z-40 flex items-stretch justify-stretch bg-black/65 px-4 pb-4 pt-12 backdrop-blur-sm"
        : "fixed inset-0 z-240 flex items-start justify-center overflow-y-auto bg-black/60 p-4 backdrop-blur-sm sm:items-center"
      }
      onMouseDown={onClose}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="mirrorsim-settings-title"
        className={embedded
          ? "flex h-full w-full flex-col overflow-hidden rounded-[22px] border border-white/10 bg-[#17191d] shadow-[0_24px_72px_rgba(0,0,0,0.52)]"
          : "flex max-h-[calc(100dvh-2rem)] w-full max-w-115 flex-col overflow-hidden rounded-[28px] border border-white/10 bg-[#17191d] shadow-[0_24px_72px_rgba(0,0,0,0.52)]"
        }
        onMouseDown={(event) => event.stopPropagation()}
      >
        {/* Header */}
        <div className={embedded ? "flex shrink-0 items-center justify-between gap-3 border-b border-white/7 px-4 py-3" : "flex shrink-0 items-center justify-between gap-4 border-b border-white/7 px-5 py-4"}>
          <h2 id="mirrorsim-settings-title" className="text-[15px] font-semibold tracking-tight text-white">Preferences</h2>
          <button ref={closeButtonRef} type="button" className={btn} onClick={onClose}>
            Close
          </button>
        </div>

        <nav className="flex shrink-0 gap-1 overflow-x-auto border-b border-white/7 px-3 py-2" aria-label="Preference sections">
          {settingsSections.map((section) => (
            <button
              key={section.id}
              type="button"
              className={`shrink-0 rounded-lg px-3 py-1.5 text-[11px] font-medium transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-400/60 ${
                activeSection === section.id
                  ? "bg-white/10 text-white"
                  : "text-white/42 hover:bg-white/5 hover:text-white/75"
              }`}
              aria-current={activeSection === section.id ? "page" : undefined}
              onClick={() => setActiveSection(section.id)}
            >
              {section.label}
            </button>
          ))}
        </nav>

        {/* Scrollable content */}
        <div className={embedded ? "min-h-0 flex-1 overflow-y-auto px-4 pb-5" : "min-h-0 flex-1 overflow-y-auto px-5 pb-6"}>

          {activeSection === "general" && <>
          {/* ── General ── */}
          <div className={`${sectionHeader} pt-5 pb-2`}>General</div>
          <div className="divide-y divide-white/7">
            <div className="py-3">
              <div className={fieldLabel}>Default view</div>
              <select
                aria-label="Default view"
                className={fieldInput}
                value={appPreferences.launchMode}
                onChange={(event) => setAppPreference("launchMode", event.target.value as AppMode)}
              >
                <option value="console">Console — full view with controls</option>
                <option value="minimal">Minimal — compact overlay</option>
              </select>
            </div>
            <div className="py-3">
              <div className={fieldLabel}>Preview quality</div>
              <select
                aria-label="Preview quality"
                className={fieldInput}
                value={appPreferences.previewQualityPreset}
                onChange={(event) => setAppPreference("previewQualityPreset", event.target.value as PreviewQualityPreset)}
              >
                <option value="quality">High quality</option>
                <option value="balanced">Balanced</option>
                <option value="speed">Fast</option>
              </select>
              <p className={fieldNote}>{previewPresetDescription} Doesn't affect your iPhone's actual stream quality.</p>
            </div>
            <div className="py-3">
              <div className={fieldLabel}>Screen Mirroring name</div>
              <input
                aria-label="Screen Mirroring name"
                type="text"
                className={fieldInput}
                value={appPreferences.receiverDisplayName}
                onChange={(event) => setAppPreference("receiverDisplayName", event.target.value)}
                placeholder="MirrorSim – Office"
                maxLength={48}
                autoComplete="off"
                spellCheck={false}
                disabled={sessionActive}
              />
              <p className={fieldNote}>
                {sessionActive
                  ? "Stop listening before changing the name shown to nearby iPhones."
                  : "This is what nearby iPhones see. Use a unique name when more than one PC runs MirrorSim."}
              </p>
            </div>
            <div className="py-3">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <div className="text-sm text-white/80">iPhone audio</div>
                  <div className="mt-0.5 text-[11px] text-white/38">
                    {audioAvailable ? audioStatus : "Requires an audio-capable AirPlay runtime."}
                  </div>
                </div>
                <Toggle
                  label="Play iPhone audio"
                  checked={!appPreferences.audioMuted}
                  onChange={(enabled) => setAppPreference("audioMuted", !enabled)}
                  disabled={!audioAvailable}
                />
              </div>
              <label className="mt-3 block text-[11px] text-white/45">
                Playback volume — {Math.round(appPreferences.audioVolume * 100)}%
                <input
                  aria-label="iPhone audio volume"
                  className="mt-2 w-full accent-blue-500 disabled:opacity-40"
                  type="range"
                  min="0"
                  max="1"
                  step="0.05"
                  value={appPreferences.audioVolume}
                  disabled={!audioAvailable}
                  onChange={(event) => setAppPreference("audioVolume", Number(event.target.value))}
                />
              </label>
              <p className={fieldNote}>Muting playback does not remove audio from new recordings.</p>
            </div>
            <div className="flex items-start justify-between gap-4 py-3">
              <div>
                <div className="text-sm text-white/80">Solid window background</div>
                <div className="mt-0.5 text-[11px] text-white/38">Opaque dark background instead of transparent glass.</div>
              </div>
              <Toggle
                label="Solid window background"
                checked={appPreferences.useOpaqueWindowBackground}
                onChange={(value) => setAppPreference("useOpaqueWindowBackground", value)}
              />
            </div>
            <div className="flex items-center justify-between gap-4 py-3">
              <span className="text-sm text-white/80">Remember last view mode</span>
              <Toggle label="Remember last view mode" checked={appPreferences.rememberLastMode} onChange={(value) => setAppPreference("rememberLastMode", value)} />
            </div>
            <div className="flex items-center justify-between gap-4 py-3">
              <span className="text-sm text-white/80">Remember last orientation</span>
              <Toggle label="Remember last orientation" checked={appPreferences.rememberLastOrientation} onChange={(value) => setAppPreference("rememberLastOrientation", value)} />
            </div>
            <div className="flex items-center justify-between gap-4 py-3">
              <span className="text-sm text-white/80">Keep Minimal window always on top</span>
              <Toggle label="Keep Minimal window always on top" checked={appPreferences.keepMinimalOnTop} onChange={(value) => setAppPreference("keepMinimalOnTop", value)} />
            </div>
          </div>

          <div className={`${sectionHeader} mt-6 pb-2`}>Orientation</div>
          <div className={infoBox}>
            Use Rotate in the toolbar when your iPhone changes orientation. MirrorSim deliberately does not infer phone rotation from video dimensions because media apps can publish landscape video while the phone itself remains portrait.
          </div>
          </>}

          {activeSection === "capture" && <>
          {/* ── Screenshots ── */}
          <div className={`${sectionHeader} mt-6 pb-2`}>Screenshots</div>
          <div className="divide-y divide-white/7">
            <div className="flex items-center justify-between gap-4 py-3">
              <span className="text-sm text-white/80">Save to disk</span>
              <Toggle label="Save screenshots to disk" checked={screenshotSettings.saveToDisk} onChange={(value) => setScreenshotSetting("saveToDisk", value)} />
            </div>
            <div className="flex items-center justify-between gap-4 py-3">
              <span className="text-sm text-white/80">Copy to clipboard</span>
              <Toggle label="Copy screenshots to clipboard" checked={screenshotSettings.copyToClipboard} onChange={(value) => setScreenshotSetting("copyToClipboard", value)} />
            </div>
            <div className="flex items-start justify-between gap-4 py-3">
              <div>
                <div className="text-sm text-white/80">Include device frame</div>
                <div className="mt-0.5 text-[11px] text-white/38">Exports the screenshot inside MirrorSim's presentation-ready phone shell.</div>
              </div>
              <Toggle label="Include device frame in screenshots" checked={screenshotSettings.includeDeviceFrame} onChange={(value) => setScreenshotSetting("includeDeviceFrame", value)} />
            </div>
            <div className="flex items-start justify-between gap-4 py-3">
              <div>
                <div className="text-sm text-white/80">Open in Explorer after saving</div>
                <div className="mt-0.5 text-[11px] text-white/38">Reveals the file in File Explorer each time.</div>
              </div>
              <Toggle label="Open saved screenshots in Explorer" checked={appPreferences.autoRevealSavedCaptures} onChange={(value) => setAppPreference("autoRevealSavedCaptures", value)} />
            </div>
            <div className="flex items-center justify-between gap-4 py-3">
              <span className="text-sm text-white/80">Show capture flash</span>
              <Toggle label="Show screenshot capture flash" checked={appPreferences.screenshotFlashEnabled} onChange={(value) => setAppPreference("screenshotFlashEnabled", value)} />
            </div>
          </div>
          {!screenshotSettings.saveToDisk && !screenshotSettings.copyToClipboard && (
            <p className="mt-2 text-[11px] text-amber-300/80">Enable at least one action, or screenshots won't go anywhere.</p>
          )}

          {/* ── Screenshot Folder ── */}
          <div className={`${sectionHeader} mt-6 pb-2`}>Screenshot Folder</div>
          <div className="divide-y divide-white/7">
            <div className="py-3">
              <div className={fieldLabel}>Save to</div>
              <select
                aria-label="Screenshot save location"
                className={fieldInput}
                value={screenshotSettings.saveLocation}
                onChange={(event) => setScreenshotSetting("saveLocation", event.target.value as ScreenshotSaveLocation)}
              >
                <option value="pictures">Pictures / MirrorSim</option>
                <option value="documents">Documents / MirrorSim</option>
                <option value="downloads">Downloads / MirrorSim</option>
                <option value="custom">Custom folder…</option>
              </select>
            </div>
            {screenshotSettings.saveLocation === "custom" && (
              <div className="py-3">
                <div className={fieldLabel}>Folder path</div>
                <div className="flex gap-2">
                  <input
                    aria-label="Custom screenshot folder"
                    type="text"
                    className={`${fieldInput} min-w-0 flex-1`}
                    value={screenshotSettings.customSavePath}
                    onChange={(event) => setScreenshotSetting("customSavePath", event.target.value)}
                    placeholder="C:\Users\You\Pictures\MirrorSim"
                  />
                  <button type="button" className={btn} onClick={onChooseScreenshotFolder}>
                    Browse
                  </button>
                </div>
                <p className={fieldNote}>Created automatically if it doesn't exist.</p>
              </div>
            )}
            <div className="py-3">
              <div className={fieldLabel}>Filename prefix</div>
              <input
                aria-label="Screenshot filename prefix"
                type="text"
                className={fieldInput}
                value={screenshotSettings.fileNamePrefix}
                onChange={(event) => setScreenshotSetting("fileNamePrefix", event.target.value)}
                placeholder="mirrorsim_screenshot"
              />
            </div>
            <div className="flex items-center justify-between gap-4 py-3">
              <span className="text-sm text-white/80">Append timestamp to filename</span>
              <Toggle label="Append timestamp to screenshot filename" checked={screenshotSettings.includeTimestamp} onChange={(value) => setScreenshotSetting("includeTimestamp", value)} />
            </div>
          </div>

          {/* ── Recordings ── */}
          <div className={`${sectionHeader} mt-6 pb-2`}>Recordings</div>
          <div className="divide-y divide-white/7">
            <div className="py-3">
              <div className={fieldLabel}>Save to</div>
              <select
                aria-label="Recording save location"
                className={fieldInput}
                value={recordingSettings.saveLocation}
                onChange={(event) => setRecordingSetting("saveLocation", event.target.value as ScreenshotSaveLocation)}
              >
                <option value="pictures">Pictures / MirrorSim</option>
                <option value="documents">Documents / MirrorSim</option>
                <option value="downloads">Downloads / MirrorSim</option>
                <option value="custom">Custom folder…</option>
              </select>
            </div>
            {recordingSettings.saveLocation === "custom" && (
              <div className="py-3">
                <div className={fieldLabel}>Folder path</div>
                <div className="flex gap-2">
                  <input
                    aria-label="Custom recording folder"
                    type="text"
                    className={`${fieldInput} min-w-0 flex-1`}
                    value={recordingSettings.customSavePath}
                    onChange={(event) => setRecordingSetting("customSavePath", event.target.value)}
                    placeholder="C:\Users\You\Videos\MirrorSim"
                  />
                  <button type="button" className={btn} onClick={onChooseRecordingFolder}>
                    Browse
                  </button>
                </div>
                <p className={fieldNote}>Created automatically if it doesn't exist.</p>
              </div>
            )}
            <div className="py-3">
              <div className={fieldLabel}>Filename prefix</div>
              <input
                aria-label="Recording filename prefix"
                type="text"
                className={fieldInput}
                value={recordingSettings.fileNamePrefix}
                onChange={(event) => setRecordingSetting("fileNamePrefix", event.target.value)}
                placeholder="mirrorsim_recording"
              />
            </div>
            <div className="flex items-center justify-between gap-4 py-3">
              <span className="text-sm text-white/80">Append timestamp to filename</span>
              <Toggle label="Append timestamp to recording filename" checked={recordingSettings.includeTimestamp} onChange={(value) => setRecordingSetting("includeTimestamp", value)} />
            </div>
            <div className="flex items-start justify-between gap-4 py-3">
              <div>
                <div className="text-sm text-white/80">Open in Explorer after saving</div>
                <div className="mt-0.5 text-[11px] text-white/38">Reveals the file in File Explorer when recording finishes.</div>
              </div>
              <Toggle label="Open saved recordings in Explorer" checked={recordingSettings.autoReveal} onChange={(value) => setRecordingSetting("autoReveal", value)} />
            </div>
            <div className="flex items-start justify-between gap-4 py-3">
              <div>
                <div className="text-sm text-white/80">Include device frame</div>
                <div className="mt-0.5 text-[11px] text-white/38">Records the live screen inside a clean phone shell.</div>
              </div>
              <Toggle label="Include device frame in recordings" checked={recordingSettings.includeDeviceFrame} onChange={(value) => setRecordingSetting("includeDeviceFrame", value)} />
            </div>
          </div>
          <p className="mt-2 text-[11px] leading-4 text-white/38">Recording quality follows your Preview Quality setting. Screenshot exports use the full source frame.</p>
          </>}

          {activeSection === "connection" && <>
          {/* ── Connection ── */}
          <div className={`${sectionHeader} mt-6 pb-2`}>Connection</div>
          <div className="divide-y divide-white/7">
            <div className="flex items-start justify-between gap-4 py-3">
              <div>
                <div className="text-sm text-white/80">Listen automatically on launch</div>
                <div className="mt-0.5 text-[11px] text-white/38">Automatically make MirrorSim available in Screen Mirroring when the app opens.</div>
              </div>
              <Toggle label="Listen automatically when MirrorSim opens" checked={appPreferences.autoStartDiscovery} onChange={(value) => setAppPreference("autoStartDiscovery", value)} />
            </div>
            <div className="flex items-start justify-between gap-4 py-3">
              <div>
                <div className="text-sm text-white/80">Auto-reconnect after drops</div>
                <div className="mt-0.5 text-[11px] text-white/38">Reconnect automatically if the connection is lost unexpectedly.</div>
              </div>
              <Toggle label="Reconnect automatically after a drop" checked={appPreferences.autoReconnectOnDrop} onChange={(value) => setAppPreference("autoReconnectOnDrop", value)} />
            </div>
          </div>

          {/* ── Network & Discovery ── */}
          <div className="mt-6 flex items-center justify-between pb-2">
            <div className={sectionHeader}>Network & Discovery</div>
            <span className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[10px] font-medium ${bonjourNeedsAttention ? "border-amber-400/20 bg-amber-500/10 text-amber-200" : "border-emerald-400/20 bg-emerald-500/10 text-emerald-300"}`}>
              <span className={`h-1.5 w-1.5 rounded-full ${bonjourNeedsAttention ? "bg-amber-300" : "bg-emerald-400"}`} />
              {bonjourNeedsAttention ? "Needs attention" : "Ready"}
            </span>
          </div>
          <div className={infoBox}>
            <div><span className="text-white/30">Bonjour</span> — {bonjourStatus.detail}</div>
            <div className="mt-1"><span className="text-white/30">Receiver</span> — {receiverReady ? "Listening for devices" : receiverRuntime.lastError ?? "Starting up"}</div>
            <div className="mt-1"><span className="text-white/30">Visible to iPhone as</span> — {receiverDisplayName}</div>
          </div>
          <div className="mt-2 flex flex-wrap gap-1.5">
            <button type="button" className={btn} onClick={onRefreshBonjourStatus} disabled={commandPending}>Recheck Bonjour</button>
            <button type="button" className={btn} onClick={onOpenWindowsServices}>Windows Services</button>
            <button type="button" className={btn} onClick={onOpenWindowsFirewall}>Windows Firewall</button>
            <button type="button" className={btn} onClick={onInstallBonjour}>Install Bonjour</button>
          </div>
          <ol className="mt-3 space-y-1 text-[11px] leading-5 text-white/38">
            <li>1. Keep MirrorSim open and running.</li>
            <li>2. On your iPhone, open Control Center and tap Screen Mirroring.</li>
            <li>3. Look for <span className="text-white/65">{receiverDisplayName}</span> on the same Wi-Fi network.</li>
            <li>4. Not showing up? Use Recheck Bonjour and confirm Windows Firewall isn't blocking MirrorSim.</li>
          </ol>
          </>}

          {activeSection === "devices" && <>
          {/* ── Device Trust ── */}
          <div className="mt-6 flex items-center justify-between pb-2">
            <div className={sectionHeader}>Device Trust</div>
            {hasTrustedDevices && (
              <button
                type="button"
                className={pendingConfirmation === "reset-all" ? btnDestructive : btnSm}
                onClick={() => confirmDestructiveAction("reset-all", onResetTrustedDevices)}
                disabled={commandPending}
              >
                {pendingConfirmation === "reset-all" ? "Confirm reset" : "Reset all"}
              </button>
            )}
          </div>
          <div className="divide-y divide-white/7">
            <div className="py-3">
              <div className={fieldLabel}>When a new iPhone connects</div>
              <select
                aria-label="New iPhone access policy"
                className={fieldInput}
                value={appPreferences.receiverAccessMode}
                onChange={(event) => setAppPreference("receiverAccessMode", event.target.value as ReceiverAccessMode)}
                disabled={sessionActive}
              >
                <option value="remember-trusted">Remember approved iPhones on this PC</option>
                <option value="ask">Ask each time — don't remember</option>
                <option value="known-only">Allow known iPhones only</option>
              </select>
              <p className={fieldNote}>
                {sessionActive
                  ? "Stop listening before changing who can connect."
                  : appPreferences.receiverAccessMode === "remember-trusted"
                  ? "Approved devices are added to this PC's trusted list and can reconnect automatically."
                  : appPreferences.receiverAccessMode === "known-only"
                    ? "Only iPhones already listed on this PC are allowed to start a session."
                    : "Every connection requires approval. Devices aren't remembered unless saved manually."}
              </p>
            </div>
          </div>

          {currentDeviceVisible ? (
            <div className={`mt-3 ${infoBox}`}>
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <div className="group relative inline-flex max-w-full items-center">
                    <div className="truncate text-sm font-medium text-white/88 underline decoration-dotted underline-offset-3 decoration-white/18">
                      {currentDeviceLabel}
                    </div>
                    <div className="pointer-events-none absolute left-0 top-full z-10 mt-2 w-72 rounded-2xl border border-white/10 bg-[#101215]/96 p-3 opacity-0 shadow-[0_16px_40px_rgba(0,0,0,0.45)] transition duration-150 group-hover:opacity-100 group-focus-within:opacity-100">
                      <div className="text-[10px] font-semibold uppercase tracking-[0.08em] text-white/35">Device Details</div>
                      <div className="mt-2 space-y-1 text-[11px] leading-4 text-white/68">
                        {currentDeviceHoverDetails().map((detail) => (
                          <div key={detail}>{detail}</div>
                        ))}
                      </div>
                    </div>
                  </div>
                  <div className="mt-0.5 text-[11px] text-white/40">
                    {session.currentDeviceBlocked
                      ? session.currentDeviceBlockedReason ?? "This iPhone is blocked on this PC."
                      : session.currentDeviceTrusted
                      ? "Already remembered on this PC."
                      : appPreferences.receiverAccessMode === "remember-trusted"
                        ? "Connected, but not yet saved to the trusted list."
                        : "Session only. Will ask again next time unless saved."}
                  </div>
                </div>
                {session.currentDeviceBlocked ? (
                  <span className="inline-flex items-center rounded-full border border-red-400/20 bg-red-500/10 px-2 py-0.5 text-[10px] font-medium text-red-300">
                    Blocked
                  </span>
                ) : session.currentDeviceTrusted ? (
                  <span className="inline-flex items-center rounded-full border border-emerald-400/20 bg-emerald-500/10 px-2 py-0.5 text-[10px] font-medium text-emerald-300">
                    Trusted
                  </span>
                ) : (
                  <button type="button" className={btnSm} onClick={onTrustCurrentDevice} disabled={commandPending}>
                    Remember
                  </button>
                )}
              </div>
            </div>
          ) : (
            <p className="mt-2 text-[11px] text-white/35">No iPhone connected. Once you approve one it will appear here.</p>
          )}

          {hasTrustedDevices && (
            <div className="mt-3 space-y-2">
              {trustedDevices.map((device) => (
                <div key={device.key} className="rounded-xl border border-white/7 bg-[#111315] px-3 py-3">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <div className="group relative min-w-0">
                          <div className="truncate text-sm font-medium text-white/88 underline decoration-dotted underline-offset-3 decoration-white/18">
                            {device.nickname ?? device.displayName}
                          </div>
                          <div className="pointer-events-none absolute left-0 top-full z-10 mt-2 w-72 rounded-2xl border border-white/10 bg-[#101215]/96 p-3 opacity-0 shadow-[0_16px_40px_rgba(0,0,0,0.45)] transition duration-150 group-hover:opacity-100 group-focus-within:opacity-100">
                            <div className="text-[10px] font-semibold uppercase tracking-[0.08em] text-white/35">Device Details</div>
                            <div className="mt-2 space-y-1 text-[11px] leading-4 text-white/68">
                              {trustedDeviceHoverDetails(device).map((detail) => (
                                <div key={detail}>{detail}</div>
                              ))}
                            </div>
                          </div>
                        </div>
                        <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-medium ${deviceStatusTone(device)}`}>
                          {device.isBlocked ? "Blocked" : device.pendingPairing ? "Pending" : device.trustedAt ? "Trusted" : "Known"}
                        </span>
                      </div>
                      <div className="mt-1 text-[11px] leading-4 text-white/40">{deviceHealthSummary(device)}</div>
                      <div className="mt-1 grid gap-0.5 text-[10px] leading-4 text-white/28 sm:grid-cols-2">
                        <div>First seen: {formatTimestamp(device.firstSeenAt)}</div>
                        <div>Last seen: {formatTimestamp(device.lastSeenAt)}</div>
                      </div>
                    </div>
                    <button
                      type="button"
                      className={pendingConfirmation === `forget-${device.key}` ? btnDestructive : btnSm}
                      onClick={() => confirmDestructiveAction(`forget-${device.key}`, () => onForgetTrustedDevice(device.key))}
                      disabled={commandPending}
                    >
                      {pendingConfirmation === `forget-${device.key}` ? "Confirm forget" : "Forget"}
                    </button>
                  </div>

                  <div className="mt-3 flex gap-2">
                    <input
                      aria-label={`Nickname for ${device.displayName}`}
                      type="text"
                      className="min-w-0 flex-1 rounded-xl border border-white/8 bg-[#0d0e10] px-3 py-1.5 text-[11px] text-white/85 outline-none placeholder:text-white/22"
                      value={nicknameDrafts[device.key] ?? ""}
                      onChange={(event) => setNicknameDrafts((previous) => ({ ...previous, [device.key]: event.target.value }))}
                      placeholder="Nickname"
                    />
                    <button
                      type="button"
                      className={btnSm}
                      onClick={() => onRenameTrustedDevice(device.key, nicknameDrafts[device.key] ?? "")}
                      disabled={commandPending}
                    >
                      Save
                    </button>
                  </div>

                  <div className="mt-2 flex gap-2">
                    <input
                      aria-label={`Block reason for ${device.displayName}`}
                      type="text"
                      className="min-w-0 flex-1 rounded-xl border border-white/8 bg-[#0d0e10] px-3 py-1.5 text-[11px] text-white/85 outline-none placeholder:text-white/22"
                      value={blockReasonDrafts[device.key] ?? ""}
                      onChange={(event) => setBlockReasonDrafts((previous) => ({ ...previous, [device.key]: event.target.value }))}
                      placeholder="Block reason (optional)"
                    />
                    <button
                      type="button"
                      className={btnDestructive}
                      onClick={() => onSetTrustedDeviceBlocked(device.key, true, blockReasonDrafts[device.key])}
                      disabled={commandPending || device.isBlocked}
                    >
                      Block
                    </button>
                    <button
                      type="button"
                      className={btnSm}
                      onClick={() => onSetTrustedDeviceBlocked(device.key, false)}
                      disabled={commandPending || !device.isBlocked}
                    >
                      Unblock
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
          {!hasTrustedDevices && (
            <p className="mt-2 text-[11px] text-white/30">No remembered devices. Connect and approve an iPhone to add it here.</p>
          )}
          </>}

          {activeSection === "support" && <>
          {/* ── Diagnostics ── */}
          <div className="mt-6 flex items-center justify-between pb-2">
            <div className={sectionHeader}>Diagnostics</div>
            <button type="button" className={btnSm} onClick={onExportDiagnostics} disabled={commandPending}>
              Export
            </button>
          </div>
          {lastDiagnosticsExport && (
            <p className="mb-2 text-[11px] leading-4 text-white/38">
              Last export: {lastDiagnosticsExport.fileName} — {lastDiagnosticsExport.entryCount} entries at {formatTimestamp(lastDiagnosticsExport.exportedAt)}.
            </p>
          )}
          <p className="mb-3 text-[10px] leading-4 text-white/32">Exported diagnostics redact device IDs, trust keys, session IDs, and pairing challenge IDs by default. Review the file before sharing it.</p>
          {historyPreview.length > 0 ? (
            <div className="space-y-1.5">
              {historyPreview.map((entry, index) => (
                <div key={`${entry.id}-${index}`} className="rounded-xl border border-white/7 bg-[#111315] px-3 py-2.5">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-[11px] font-medium text-white/80">{entry.message}</div>
                      <div className="mt-0.5 text-[10px] leading-4 text-white/35">
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
            <p className="text-[11px] text-white/30">No connection history yet.</p>
          )}

          {/* ── Advanced ── */}
          <div className={`${sectionHeader} mt-6 pb-2`}>Advanced</div>
          <div className="divide-y divide-white/7">
            <div className="flex items-start justify-between gap-4 py-3">
              <div>
                <div className="text-sm text-white/80">Auto-open diagnostics on errors</div>
                <div className="mt-0.5 text-[11px] text-white/38">Opens the diagnostics panel automatically when receiver or preview errors occur.</div>
              </div>
              <Toggle
                label="Open diagnostics automatically on errors"
                checked={appPreferences.openDiagnosticsOnError}
                onChange={(value) => setAppPreference("openDiagnosticsOnError", value)}
              />
            </div>
          </div>

          <div className={`${sectionHeader} mt-6 pb-2`}>About &amp; Support</div>
          <div className={infoBox}>
            <div className="flex items-center justify-between gap-4">
              <span className="text-white/38">MirrorSim version</span>
              <strong className="font-medium text-white/82">{appVersion}</strong>
            </div>
            <div className="mt-2 flex items-center justify-between gap-4">
              <span className="text-white/38">Updates</span>
              <span className="text-right text-white/72">{updateStatus}</span>
            </div>
            {updateError && <p className="mt-2 break-words text-amber-200/75">{updateError}</p>}
            <button type="button" className={`${btn} mt-3`} onClick={onCheckForUpdates} disabled={commandPending}>Check for updates</button>
          </div>
          <div className="mt-2 flex flex-wrap gap-1.5">
            <button type="button" className={btn} onClick={onOpenProject}>GitHub</button>
            <button type="button" className={btn} onClick={onOpenIssues}>Report an issue</button>
            <button type="button" className={btn} onClick={onOpenLicense}>MIT license</button>
            <button type="button" className={btn} onClick={onOpenThirdPartyNotices}>Third-party licenses</button>
          </div>

          <div className={`${sectionHeader} mt-6 pb-2`}>Privacy</div>
          <div className={infoBox}>
            Mirrored video and audio are processed locally on this PC. MirrorSim does not upload frames or captures. Network activity is limited to local AirPlay/Bonjour traffic, update checks, and links you choose to open.
          </div>

          <div className={`${sectionHeader} mt-6 pb-2`}>Known Limitations</div>
          <ul className={`${infoBox} list-disc space-y-1 pl-7`}>
            <li>DRM-protected video may appear black.</li>
            <li>Some apps publish a separate landscape playback surface; rotate MirrorSim manually when needed.</li>
            <li>Bonjour and Windows Firewall configuration can affect discovery.</li>
            <li>Unsigned beta installers may trigger Microsoft Defender SmartScreen.</li>
          </ul>
          </>}

        </div>
      </div>
    </div>
  );
}
