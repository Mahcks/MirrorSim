import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type MouseEvent as ReactMouseEvent } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getVersion } from "@tauri-apps/api/app";
import { openUrl } from "@tauri-apps/plugin-opener";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { cn } from "@/lib/utils";
import {
  DEVICE_RENDER_WIDTH,
  MINIMAL_SHELL_WIDTH,
  PREVIEW_QUALITY_PRESETS,
  ZOOM_LEVELS,
  type ZoomLevel,
} from "@/features/mirrorsim/constants";
import {
  canCapturePreviewFrame,
  formatAppleDeviceModel,
  fmtError,
} from "@/features/mirrorsim/helpers";
import { ConsoleView } from "@/features/mirrorsim/components/ConsoleView";
import {
  getConnectionPresentation,
  type PendingSessionCommand,
} from "@/features/mirrorsim/connectionFlow";
import { getModalVisibility } from "@/features/mirrorsim/modalFlow";
import {
  getUpdatePrimaryAction,
  isUpdateRestartSafe,
  type AppUpdateState,
} from "@/features/mirrorsim/updateFlow";
import { DeviceFrame } from "@/features/mirrorsim/components/DeviceFrame";
import { MinimalContextMenu } from "@/features/mirrorsim/components/MinimalContextMenu";
import { MinimalView } from "@/features/mirrorsim/components/MinimalView";
import { PairingModal } from "@/features/mirrorsim/components/PairingModal";
import { SettingsModal, type SettingsSection } from "@/features/mirrorsim/components/SettingsModal";
import { startWindowDrag } from "@/features/mirrorsim/components/WindowControls";
import { useCaptureActions } from "@/features/mirrorsim/hooks/useCaptureActions";
import { usePreferencesState } from "@/features/mirrorsim/hooks/usePreferencesState";
import { useWindowMode } from "@/features/mirrorsim/hooks/useWindowMode";
import { usePreviewRuntime } from "./features/mirrorsim/hooks/usePreviewRuntime";
import { usePreviewAudio } from "./features/mirrorsim/hooks/usePreviewAudio";
import { useVideoAvailability } from "./features/mirrorsim/hooks/useVideoAvailability";
import type {
  AppUpdateInfo,
  AppMode,
  Capture,
  ConnectionHistoryEntry,
  ContextMenuPos,
  DiagnosticsExport,
  Orientation,
  SessionCommand,
  SessionSnapshot,
  TrustedDevice,
} from "@/features/mirrorsim/types";
import type {
  PairingSnapshot,
  BonjourStatusSnapshot,
  ReceiverRuntimeSnapshot,
} from "./receiverContract";

function getDevUpdateOverride(): AppUpdateInfo | null {
  const version = import.meta.env.VITE_DEV_UPDATER_VERSION?.trim();
  if (!version) {
    return null;
  }

  return {
    version,
    currentVersion: import.meta.env.VITE_DEV_UPDATER_CURRENT_VERSION?.trim() || "1.0.0",
    notes: import.meta.env.VITE_DEV_UPDATER_NOTES?.trim() || "This is a local dev-only updater preview.",
    pubDate: import.meta.env.VITE_DEV_UPDATER_PUB_DATE?.trim() || new Date().toISOString(),
  };
}

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

// ── App ───────────────────────────────────────────────────────────────────────

export default function App() {
  const devUpdatePreview = useMemo(getDevUpdateOverride, []);
  const [appMode, setAppMode] = useState<AppMode>("minimal");
  const [orientation, setOrientation] = useState<Orientation>("portrait");
  const [zoom, setZoom] = useState<ZoomLevel>(1);
  const [pendingOperationCount, setPendingOperationCount] = useState(0);
  const [pendingSessionCommand, setPendingSessionCommand] = useState<PendingSessionCommand>(null);
  const commandPending = pendingOperationCount > 0;
  const setCommandPending = useCallback((pending: boolean) => {
    setPendingOperationCount((count) => pending ? count + 1 : Math.max(0, count - 1));
  }, []);
  const [commandError, setCommandError] = useState<string | null>(null);
  const [captureNotice, setCaptureNotice] = useState<string | null>(null);
  const [diagExpanded, setDiagExpanded] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsSection, setSettingsSection] = useState<SettingsSection>("general");
  const [minimalChromeHidden, setMinimalChromeHidden] = useState(false);
  const [contextMenu, setContextMenu] = useState<ContextMenuPos | null>(null);
  const [captures, setCaptures] = useState<Capture[]>([]);
  const [trustedDevices, setTrustedDevices] = useState<TrustedDevice[]>([]);
  const [connectionHistory, setConnectionHistory] = useState<ConnectionHistoryEntry[]>([]);
  const [lastDiagnosticsExport, setLastDiagnosticsExport] = useState<DiagnosticsExport | null>(null);
  const [availableUpdate, setAvailableUpdate] = useState<AppUpdateInfo | null>(null);
  const [updateState, setUpdateState] = useState<AppUpdateState>("idle");
  const [updateError, setUpdateError] = useState<string | null>(null);
  const [updateBannerDismissed, setUpdateBannerDismissed] = useState(false);
  const [lastUpdateCheckMessage, setLastUpdateCheckMessage] = useState<string | null>(null);
  const [appVersion, setAppVersion] = useState("—");
  const [screenshotFlashActive, setScreenshotFlashActive] = useState(false);
  const [protectedVideoNoticeDismissed, setProtectedVideoNoticeDismissed] = useState(false);
  const [reconnectUiState, setReconnectUiState] = useState<{ attempt: number; phase: "scheduled" | "retrying" } | null>(null);
  const [reconnectNextRetryAt, setReconnectNextRetryAt] = useState<number | null>(null);
  const shouldMaintainConnectionRef = useRef(false);
  const hasReachedLiveSessionRef = useRef(false);
  const reconnectAttemptRef = useRef(0);
  const reconnectTimerRef = useRef<number | null>(null);
  const autoReconnectInFlightRef = useRef(false);
  const startupPreferencesAppliedRef = useRef(false);
  const autoDiscoveryAttemptedRef = useRef(false);
  const updateCheckAttemptedRef = useRef(false);
  const appliedOrientationRevisionRef = useRef(0);

  const {
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
  } = usePreferencesState();

  useEffect(() => {
    if (preferencesSaveError) {
      setCommandError(preferencesSaveError);
    }
  }, [preferencesSaveError]);

  useEffect(() => {
    void getVersion()
      .then(setAppVersion)
      .catch(() => setAppVersion(import.meta.env.DEV ? "development" : "unknown"));
  }, []);

  const {
    initializing: runtimeInitializing,
    session,
    setSession,
    preview,
    previewStream,
    receiverRuntime,
    setReceiverRuntime,
    bonjourStatus,
    setBonjourStatus,
    pairing,
    setPairing,
    previewDiag,
    previewClientDiag,
    videoDiag,
    videoRecoveryCount,
    surfaceStatus,
    surfaceError,
    documentVisible,
    setPreviewClientDiagnosticContext,
    retryPreview,
    videoEl,
    hasRetainedPreviewFrame,
    setVideoHost,
  } = usePreviewRuntime({
    previewPreset: PREVIEW_QUALITY_PRESETS[appPreferences.previewQualityPreset],
    setCommandError,
  });

  const { minimalShellRef, fitMinimalWindow, goMinimal, goConsole } = useWindowMode({
    appMode,
    setAppMode,
    orientation,
    zoom,
    setZoom,
    keepMinimalOnTop: appPreferences.keepMinimalOnTop,
    useOpaqueWindowBackground: appPreferences.useOpaqueWindowBackground,
    setCommandError,
  });

  const audioAvailable = session.receiverCapabilities.includes("pcm-audio");
  const senderVolumeSupported = session.receiverCapabilities.includes("sender-volume");
  const {
    audioState,
    audioError,
    effectiveVolume,
    lastAudioReceivedAtMs,
    lastAudibleAudioAtMs,
    primeAudio,
    recordingAudioTrack,
  } = usePreviewAudio({
    available: audioAvailable,
    isLive: session.status === "mirroring" || session.status === "recording",
    muted: appPreferences.audioMuted,
    volume: appPreferences.audioVolume,
    followIphoneVolume: appPreferences.followIphoneVolume && senderVolumeSupported,
    senderVolumeDb: receiverRuntime.senderVolumeDb,
    channelMode: appPreferences.audioChannelMode,
  });
  const videoAvailabilityNotice = useVideoAvailability({
    streamKey: previewStream ? `${previewStream.streamId}:${previewStream.configGeneration}` : null,
    isLive: session.status === "mirroring" || session.status === "recording",
    previewReady: surfaceStatus === "ready",
    documentVisible,
    senderPaused: receiverRuntime.videoSenderPaused,
    lastAudioReceivedAtMs,
    lastAudibleAudioAtMs,
    playbackBackend: previewClientDiag.playbackBackend,
    decodedOutputCount: previewClientDiag.decodedOutputCount,
    lastDecodedFrameAtMs: previewClientDiag.lastDecodedFrameAtMs,
    renderSurfaceConnected: previewClientDiag.renderSurfaceConnected,
    renderSurfaceHealthy: previewClientDiag.renderSurfaceHealthy,
    pixelProbeAverageLuma: previewClientDiag.pixelProbeAverageLuma,
    pixelProbeDarkRatio: previewClientDiag.pixelProbeDarkRatio,
    pixelProbeCenterAverageLuma: previewClientDiag.pixelProbeCenterAverageLuma,
    pixelProbeCenterDarkRatio: previewClientDiag.pixelProbeCenterDarkRatio,
    pixelProbeBrightRatio: previewClientDiag.pixelProbeBrightRatio,
    pixelProbeEdgeRatio: previewClientDiag.pixelProbeEdgeRatio,
    pixelProbeSequence: previewClientDiag.pixelProbeSequence,
    pixelProbeDecodedOutputCount: previewClientDiag.pixelProbeDecodedOutputCount,
    lastPixelProbeAtMs: previewClientDiag.lastPixelProbeAtMs,
  });

  useEffect(() => {
    setPreviewClientDiagnosticContext({
      videoAvailabilityNotice,
      senderPaused: receiverRuntime.videoSenderPaused,
      lastAudioReceivedAtMs,
      lastAudibleAudioAtMs,
    });
  }, [
    lastAudioReceivedAtMs,
    lastAudibleAudioAtMs,
    receiverRuntime.videoSenderPaused,
    setPreviewClientDiagnosticContext,
    videoAvailabilityNotice,
  ]);
  const captureFrameAvailable = canCapturePreviewFrame(
    session.status,
    hasRetainedPreviewFrame,
    videoDiag.videoWidth > 0 && videoDiag.videoHeight > 0,
  );

  const {
    recElapsed,
    localRecordingActive,
    finalizeInterruptedRecording,
    chooseScreenshotFolder,
    chooseRecordingFolder,
    revealCaptureInExplorer,
    doCapture,
    doRecordToggle,
  } = useCaptureActions({
    appPreferences,
    canCapture: captureFrameAvailable,
    canRecord: session.status === "mirroring" || session.status === "recording",
    isRec: session.status === "recording",
    recordingSettings,
    screenshotSettings,
    setCaptures,
    setCaptureNotice,
    setCommandError,
    setCommandPending,
    setRecordingSettings,
    setScreenshotFlashActive,
    setScreenshotSettings,
    setSession,
    videoEl,
    orientation,
    recordingAudioTrack,
  });

  const localRecordingActiveRef = useRef(localRecordingActive);
  const finalizeInterruptedRecordingRef = useRef(finalizeInterruptedRecording);
  useEffect(() => {
    localRecordingActiveRef.current = localRecordingActive;
    finalizeInterruptedRecordingRef.current = finalizeInterruptedRecording;
  }, [finalizeInterruptedRecording, localRecordingActive]);

  useEffect(() => {
    const appWindow = getCurrentWindow();
    const unlistenPromise = appWindow.onCloseRequested(async (event) => {
      if (!localRecordingActiveRef.current) {
        return;
      }

      event.preventDefault();
      const shouldSave = window.confirm(
        "A recording is still active. Stop and save it before closing MirrorSim?",
      );
      if (!shouldSave) {
        return;
      }

      const savedRecording = await finalizeInterruptedRecordingRef.current(
        "MirrorSim is closing",
      );
      if (savedRecording) {
        await appWindow.destroy();
      } else if (localRecordingActiveRef.current) {
        const closeWithRecoveryFile = window.confirm(
          "MirrorSim could not finish saving the recording. Close anyway and keep the temporary recovery file on disk?",
        );
        if (closeWithRecoveryFile) {
          await appWindow.destroy();
        }
      }
    });

    return () => {
      void unlistenPromise.then((unlisten) => unlisten());
    };
  }, []);

  // derived
  const ss = session.status;
  const isIdle = ss === "idle";
  const isLive = ss === "mirroring" || ss === "recording";
  const isRec = ss === "recording";
  const recordingBusy = isRec || localRecordingActive;
  const bonjourNeedsAttention = bonjourStatus.status === "missing" || bonjourStatus.status === "unknown";
  const receiverDisplayName = appPreferences.receiverDisplayName.trim() || "MirrorSim";
  const receiverTransportLabel = receiverRuntime.transport === "airplayserver" ? "AirPlay transport" : "Fixture transport";
  const receiverBuildLabel = session.receiverId
    ? `${session.receiverId}${session.receiverProtocolVersion ? ` v${session.receiverProtocolVersion}` : ""}`
    : null;
  const receiverStateLabel =
    receiverRuntime.state === "idle"
      ? "Idle"
      : receiverRuntime.state === "priming"
        ? "Priming"
        : receiverRuntime.state === "ready"
          ? "Ready"
          : "Streaming";
  const previewDeliveryLabel =
    previewStream?.deliveryMode === "command-stream"
      ? "Live command stream"
      : previewStream?.deliveryMode === "static-paths"
        ? "Static preview"
        : null;
  const supportsPairingTrustControl = session.receiverCapabilities.includes("pairing-trust-control");
  const approvalActionSupported = pairing.canTrust || supportsPairingTrustControl;
  const receiverCapabilityLabel = session.receiverCapabilities.includes("native-receiver-process")
    ? "Native receiver"
    : session.receiverCapabilities.length > 0
      ? `${session.receiverCapabilities.length} receiver features`
      : null;
  const connectionPresentation = getConnectionPresentation({
    initializing: runtimeInitializing,
    pendingSessionCommand,
    session,
    pairing,
    receiverRuntime,
    bonjourStatus,
    receiverDisplayName,
  });
  const modalVisibility = getModalVisibility(settingsOpen, pairing.phase);
  const pairingNeedsAttention = connectionPresentation.pairingNeedsAttention;
  const sessionHeadline = connectionPresentation.headline;
  const sessionSupportingText = connectionPresentation.supportingText;
  const sessionSecondaryLabel = connectionPresentation.secondaryLabel;
  const currentDeviceTrustLabel = session.currentDeviceKey
    ? session.currentDeviceBlocked
      ? "Blocked on this PC"
      : session.currentDeviceTrusted
        ? "Trusted device"
        : session.currentDeviceKnown
          ? "Known device"
        : pairingNeedsAttention || connectionPresentation.pairingInProgress
          ? "Pairing pending"
          : "New device"
    : null;
  const currentDeviceModelLabel = formatAppleDeviceModel(session.currentDeviceModel);
  const currentDeviceOsLabel = session.currentDeviceOsVersion
    ? `${session.currentDeviceOsName ?? "iPhone OS"} ${session.currentDeviceOsVersion}${session.currentDeviceOsBuildVersion ? ` (${session.currentDeviceOsBuildVersion})` : ""}`
    : session.currentDeviceOsName;
  const reconnectAttemptLabel = reconnectUiState && reconnectUiState.attempt > 1 ? ` #${reconnectUiState.attempt}` : "";
  const titlebarStateLabel = reconnectUiState?.phase === "retrying"
    ? `Reconnecting${reconnectAttemptLabel}`
    : connectionPresentation.titlebarLabel;
  const titlebarStateDotClass = cn(
    "h-1.5 w-1.5 shrink-0 rounded-full",
    connectionPresentation.tone === "live"
      ? "bg-emerald-400"
      : connectionPresentation.tone === "warning"
        ? "bg-red-400"
        : connectionPresentation.tone === "active"
          ? "bg-cyan-300"
          : "bg-white/35",
  );
  const primarySessionActionLabel = localRecordingActive && !isRec
    ? "Retry saving recording"
    : connectionPresentation.primaryActionLabel;
  const primarySessionActionDisabled = commandPending || runtimeInitializing;
  const showRetryConnection = isIdle && !bonjourNeedsAttention && Boolean(receiverRuntime.lastError);
  const previewHasDrawableFrame = hasRetainedPreviewFrame
    || (videoDiag.videoWidth > 0 && videoDiag.videoHeight > 0);
  // Screenshot capture keeps the last decoded canvas frame even if the live
  // decoder subsequently fails or the video element loses its ready state.
  const canCapture = captureFrameAvailable;
  const canRecord = (isLive && previewHasDrawableFrame && surfaceStatus === "ready") || localRecordingActive;
  const tone: "inactive" | "live" | "warning" =
    connectionPresentation.tone === "warning" || surfaceStatus === "error" || surfaceStatus === "unsupported"
      ? "warning"
      : isLive && surfaceStatus === "ready"
        ? "live"
        : "inactive";
  const bufferedAhead = Math.max(0, videoDiag.bufferedEnd - videoDiag.currentTime);
  const previewPreset = PREVIEW_QUALITY_PRESETS[appPreferences.previewQualityPreset];
  const reconnectCountdownSeconds = reconnectNextRetryAt === null ? null : Math.max(0, Math.ceil((reconnectNextRetryAt - Date.now()) / 1000));
  const projectPageUrl = "https://github.com/Mahcks/MirrorSim";
  const releasePageUrl = `${projectPageUrl}/releases/latest`;
  const issuesPageUrl = `${projectPageUrl}/issues`;
  const licensePageUrl = `${projectPageUrl}/blob/main/LICENSE`;
  const thirdPartyNoticesUrl = `${projectPageUrl}/blob/main/THIRD_PARTY_NOTICES.md`;
  const shouldShowUpdateBadge = !updateBannerDismissed && ["downloading", "available", "ready", "installing"].includes(updateState);
  const updateRestartSafe = isUpdateRestartSafe(ss) && !localRecordingActive;
  const updatePrimaryAction = getUpdatePrimaryAction({
    updateState,
    sessionState: ss,
    devPreview: Boolean(import.meta.env.DEV && devUpdatePreview),
  });
  const zoomIndex = ZOOM_LEVELS.indexOf(zoom);
  const controlButtonClass =
    "inline-flex h-8 w-8 items-center justify-center rounded-[5px] text-white/55 transition hover:bg-[#1a1b1e] hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-cyan-300/65 disabled:cursor-default disabled:opacity-30";
  const minimalFloatingButtonClass =
    "inline-flex h-7 w-7 cursor-pointer items-center justify-center rounded-lg text-white/65 transition hover:bg-white/8 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-cyan-300/65 disabled:cursor-default disabled:opacity-30";
  const panelSurfaceClass =
    "border-white/7 bg-[#131416]";
  const previewDimClass =
    tone === "warning" ? "opacity-[0.08]" : tone === "inactive" ? "opacity-0" : "opacity-100";
  const screenFrameClass = cn(
    "relative overflow-hidden bg-[#050506] shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]",
    orientation === "portrait" ? "aspect-[393/852] rounded-[46px]" : "aspect-[852/393] rounded-[34px]",
    recordingBusy && "shadow-[0_0_0_1.5px_rgba(239,68,68,0.48),0_0_40px_rgba(239,68,68,0.10)]",
  );
  const deviceFrameWidth = DEVICE_RENDER_WIDTH[orientation];
  const deviceWidthClass = orientation === "portrait" ? "rounded-[52px]" : "rounded-[40px]";
  const previewVideoStyle: CSSProperties = {
    imageRendering: previewPreset.imageRendering,
    filter: previewPreset.filter,
  };

  useEffect(() => {
    if (videoAvailabilityNotice === null) {
      setProtectedVideoNoticeDismissed(false);
    }
  }, [videoAvailabilityNotice]);

  useEffect(() => {
    void invoke<BonjourStatusSnapshot>("get_bonjour_status")
      .then(setBonjourStatus)
      .catch(() => undefined);
  }, [session.status, setBonjourStatus]);

  function renderReconnectBadge(compact = false) {
    if (!reconnectUiState || reconnectUiState.phase !== "scheduled") return null;

    const content = `Reconnect${reconnectCountdownSeconds !== null ? ` in ${reconnectCountdownSeconds}s` : " queued"}`;
    const compactContent = reconnectCountdownSeconds !== null ? `Retry ${reconnectCountdownSeconds}s` : "Retry queued";

    return (
      <span
        className={cn(
          "inline-flex min-w-0 items-center gap-1 whitespace-nowrap rounded-full border border-amber-400/20 bg-amber-400/10 text-amber-200",
          compact ? "px-1.5 py-0.5 text-[10px] font-medium tracking-[-0.01em]" : "px-2 py-0.5 text-[11px] font-medium tracking-[-0.01em]",
        )}
        title={`${content}. Cancel automatic reconnect.`}
      >
        <span className="h-1.5 w-1.5 rounded-full bg-amber-300" />
        <span className="truncate">{compact ? compactContent : content}</span>
        <button
          type="button"
          className="ml-0.5 shrink-0 rounded px-1 text-amber-100/70 transition hover:bg-amber-100/10 hover:text-amber-50 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-amber-200"
          onClick={() => {
            shouldMaintainConnectionRef.current = false;
            reconnectAttemptRef.current = 0;
            clearAutoReconnectTimer();
            setReconnectUiState(null);
          }}
          aria-label="Cancel automatic reconnect"
          title="Cancel automatic reconnect"
        >
          {compact ? "×" : "Cancel"}
        </button>
      </span>
    );
  }

  function renderTechnicalDetails() {
    return (
      <details className="group mt-3 border-t border-white/7 pt-3">
        <summary className="flex cursor-pointer list-none items-center justify-between gap-2 text-[11px] font-medium text-white/50 transition group-open:text-white/75">
          <span>Technical details</span>
          <span className="text-sm leading-none text-white/40 transition-transform group-open:rotate-90" aria-hidden="true">›</span>
        </summary>
        <div className="mt-2 space-y-2 text-[11px]">
          <div className="flex items-center justify-between gap-3">
            <span className="text-white/45">Receiver name</span>
            <strong className="max-w-[60%] truncate text-right font-medium text-white/80" title={receiverDisplayName}>{receiverDisplayName}</strong>
          </div>
          {receiverBuildLabel && (
            <div className="flex items-center justify-between gap-3">
              <span className="text-white/45">Receiver build</span>
              <strong className="max-w-[60%] truncate text-right font-medium text-white/80" title={receiverBuildLabel}>{receiverBuildLabel}</strong>
            </div>
          )}
          <div className="flex items-center justify-between gap-3">
            <span className="text-white/30">Transport</span>
            <strong className="max-w-[60%] truncate text-right font-medium text-white/80" title={receiverTransportLabel}>{receiverTransportLabel}</strong>
          </div>
          <div className="flex items-center justify-between gap-3">
            <span className="text-white/30">Receiver state</span>
            <strong className="max-w-[60%] truncate text-right font-medium text-white/80" title={receiverStateLabel}>{receiverStateLabel}</strong>
          </div>
          {previewDeliveryLabel && (
            <div className="flex items-center justify-between gap-3">
              <span className="text-white/30">Preview path</span>
              <strong className="max-w-[60%] truncate text-right font-medium text-white/80" title={previewDeliveryLabel}>{previewDeliveryLabel}</strong>
            </div>
          )}
          {previewStream?.mimeType && (
            <div className="flex items-center justify-between gap-3">
              <span className="text-white/30">Codec</span>
              <strong className="max-w-[60%] truncate text-right font-medium text-white/80" title={previewStream.mimeType}>{previewStream.mimeType}</strong>
            </div>
          )}
          {receiverCapabilityLabel && (
            <div className="flex items-center justify-between gap-3">
              <span className="text-white/30">Capabilities</span>
              <strong className="max-w-[60%] truncate text-right font-medium text-white/80" title={session.receiverCapabilities.join(", ")}>{receiverCapabilityLabel}</strong>
            </div>
          )}
          {currentDeviceTrustLabel && (
            <div className="flex items-center justify-between gap-3">
              <span className="text-white/30">Trust</span>
              <strong className="max-w-[60%] truncate text-right font-medium text-white/80" title={currentDeviceTrustLabel}>{currentDeviceTrustLabel}</strong>
            </div>
          )}
          {session.currentDeviceId && (
            <div className="flex items-center justify-between gap-3">
              <span className="text-white/30">Device ID</span>
              <strong className="max-w-[60%] truncate text-right font-medium text-white/80" title={session.currentDeviceId}>{session.currentDeviceId}</strong>
            </div>
          )}
          {currentDeviceModelLabel && (
            <div className="flex items-center justify-between gap-3">
              <span className="text-white/30">Model</span>
              <strong className="max-w-[60%] truncate text-right font-medium text-white/80" title={currentDeviceModelLabel}>{currentDeviceModelLabel}</strong>
            </div>
          )}
          {currentDeviceOsLabel && (
            <div className="flex items-center justify-between gap-3">
              <span className="text-white/30">OS</span>
              <strong className="max-w-[60%] truncate text-right font-medium text-white/80" title={currentDeviceOsLabel}>{currentDeviceOsLabel}</strong>
            </div>
          )}
          {session.currentDeviceSourceVersion && (
            <div className="flex items-center justify-between gap-3">
              <span className="text-white/30">AirPlay stack</span>
              <strong className="max-w-[60%] truncate text-right font-medium text-white/80" title={session.currentDeviceSourceVersion}>{session.currentDeviceSourceVersion}</strong>
            </div>
          )}
          {(pairingNeedsAttention || connectionPresentation.pairingInProgress) && (
            <div className="flex items-center justify-between gap-3">
              <span className="text-white/30">Pairing</span>
              <strong className="max-w-[60%] truncate text-right font-medium text-white/80" title={pairing.phase}>{pairing.phase}</strong>
            </div>
          )}
          {receiverCapabilityLabel && (
            <div className="flex items-center justify-between gap-3">
              <span className="text-white/30">Pairing control</span>
              <strong className="max-w-[60%] truncate text-right font-medium text-white/80">
                {supportsPairingTrustControl ? "Supported" : "Unavailable in this receiver build"}
              </strong>
            </div>
          )}
        </div>
      </details>
    );
  }

  useEffect(() => {
    return scheduleAfterFirstPaint(() => {
      void Promise.all([refreshTrustedDevices(), refreshConnectionHistory()]).catch((error) => setCommandError(fmtError(error)));
    }, 120);
  }, []);

  useEffect(() => {
    if (import.meta.env.DEV && devUpdatePreview) {
      setAvailableUpdate(devUpdatePreview);
      setUpdateState("ready");
      setUpdateError(null);
      setUpdateBannerDismissed(false);
      return;
    }

    if (import.meta.env.DEV || updateCheckAttemptedRef.current) {
      return;
    }

    updateCheckAttemptedRef.current = true;
    let cancelled = false;
    const cancelScheduledCheck = scheduleAfterFirstPaint(() => {
      if (cancelled) {
        return;
      }

      setUpdateState("checking");
      setUpdateError(null);

      void (async () => {
        let update: AppUpdateInfo | null = null;
        try {
          const downloaded = await invoke<AppUpdateInfo | null>("get_downloaded_app_update");
          if (cancelled) {
            return;
          }
          if (downloaded) {
            setAvailableUpdate(downloaded);
            setUpdateState("ready");
            setUpdateBannerDismissed(false);
            return;
          }

          update = await invoke<AppUpdateInfo | null>("check_for_app_update");
          if (cancelled) {
            return;
          }
          setAvailableUpdate(update);
          if (!update) {
            setUpdateState("idle");
            return;
          }

          setUpdateState("downloading");
          setUpdateBannerDismissed(false);
          const prepared = await invoke<AppUpdateInfo | null>("download_app_update");
          if (cancelled) {
            return;
          }
          setAvailableUpdate(prepared ?? update);
          setUpdateState(prepared ? "ready" : "available");
          if (!prepared) {
            setUpdateError("The update is no longer available. MirrorSim will check again next time it starts.");
          }
        } catch (error) {
          if (cancelled) {
            return;
          }

          const message = fmtError(error);
          if (/not configured/i.test(message)) {
            setUpdateState("disabled");
            return;
          }

          setUpdateState(update ? "available" : "idle");
          setUpdateError(message);
        }
      })();
    }, 900);

    return () => {
      cancelled = true;
      cancelScheduledCheck();
    };
  }, [devUpdatePreview]);

    useEffect(() => {
      if (!session.currentDeviceKey || !session.currentDeviceTrusted) {
        return;
      }

      void refreshTrustedDevices().catch(() => {
        // best-effort sync after a newly approved device gets remembered
      });
    }, [session.currentDeviceKey, session.currentDeviceTrusted]);

  useEffect(() => {
    void refreshConnectionHistory().catch(() => {
      // best-effort diagnostics sync
    });
  }, [pairing.phase, receiverRuntime.lastError, session.status]);

  useEffect(() => {
    if (!screenshotFlashActive) return;
    const timeoutId = window.setTimeout(() => setScreenshotFlashActive(false), 180);
    return () => window.clearTimeout(timeoutId);
  }, [screenshotFlashActive]);

  useEffect(() => {
    if (!captureNotice) return;
    const timeoutId = window.setTimeout(() => setCaptureNotice(null), 9000);
    return () => window.clearTimeout(timeoutId);
  }, [captureNotice]);

  useEffect(() => {
    if (modalVisibility.pairingOpen && settingsOpen) {
      setSettingsOpen(false);
    }
  }, [modalVisibility.pairingOpen, settingsOpen]);

  useEffect(() => {
    if (appPreferences.rememberLastMode && appPreferences.lastMode !== appMode) {
      setAppPreferences((previous) => ({ ...previous, lastMode: appMode }));
    }
  }, [appMode, appPreferences.lastMode, appPreferences.rememberLastMode]);

  useEffect(() => {
    if (appPreferences.rememberLastOrientation && appPreferences.lastOrientation !== orientation) {
      setAppPreferences((previous) => ({ ...previous, lastOrientation: orientation }));
    }
  }, [appPreferences.lastOrientation, appPreferences.rememberLastOrientation, orientation]);

  useEffect(() => {
    if (!preferencesReady || startupPreferencesAppliedRef.current) return;
    startupPreferencesAppliedRef.current = true;

    const startupOrientation = appPreferences.rememberLastOrientation
      ? appPreferences.lastOrientation
      : orientation;
    const startupMode = appPreferences.rememberLastMode
      ? appPreferences.lastMode
      : appPreferences.launchMode;

    if (startupOrientation !== orientation) {
      setOrientation(startupOrientation);
    }

    void (async () => {
      if (startupMode === "minimal") {
        setAppMode("minimal");
        setZoom(1);
        await fitMinimalWindow(startupOrientation);
      } else {
        await goConsole();
      }
    })();
  }, [appPreferences, orientation, preferencesReady]);

  useEffect(() => {
    if (!appPreferences.openDiagnosticsOnError) return;
    if (receiverRuntime.lastError || surfaceError || commandError) {
      setDiagExpanded(true);
    }
  }, [appPreferences.openDiagnosticsOnError, commandError, receiverRuntime.lastError, surfaceError]);

  useEffect(() => {
    const geometry = receiverRuntime.videoGeometry;
    if (!preferencesReady || !appPreferences.autoRotateFromIphone || !geometry) return;
    if (receiverRuntime.orientationRevision <= appliedOrientationRevisionRef.current) return;
    appliedOrientationRevisionRef.current = receiverRuntime.orientationRevision;

    const nextOrientation: Orientation = geometry.orientation;
    setOrientation((currentOrientation) => {
      if (currentOrientation === nextOrientation) return currentOrientation;
      if (appMode === "minimal") {
        window.requestAnimationFrame(() => {
          window.requestAnimationFrame(() => {
            void fitMinimalWindow(nextOrientation);
          });
        });
      }
      return nextOrientation;
    });
  }, [
    appMode,
    appPreferences.autoRotateFromIphone,
    fitMinimalWindow,
    preferencesReady,
    receiverRuntime.orientationRevision,
    receiverRuntime.videoGeometry,
  ]);

  useEffect(() => {
    if (!preferencesReady || !appPreferences.autoStartDiscovery || autoDiscoveryAttemptedRef.current || ss !== "idle") {
      return;
    }

    autoDiscoveryAttemptedRef.current = true;
    void startSessionFlow("start_session", "manual");
  }, [appPreferences.autoStartDiscovery, preferencesReady, ss]);

  useEffect(() => {
    if (ss !== "idle") {
      shouldMaintainConnectionRef.current = true;
    }

    if (ss === "mirroring" || ss === "recording") {
      hasReachedLiveSessionRef.current = true;
      reconnectAttemptRef.current = 0;
      setReconnectUiState(null);
      setReconnectNextRetryAt(null);
      if (reconnectTimerRef.current !== null) {
        window.clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
    }
  }, [ss]);

  useEffect(() => {
    if (reconnectNextRetryAt === null) {
      return;
    }

    const intervalId = window.setInterval(() => {
      if (reconnectNextRetryAt <= Date.now()) {
        setReconnectNextRetryAt(null);
        window.clearInterval(intervalId);
      }
    }, 250);

    return () => window.clearInterval(intervalId);
  }, [reconnectNextRetryAt]);

  useEffect(() => {
    return () => {
      if (reconnectTimerRef.current !== null) {
        window.clearTimeout(reconnectTimerRef.current);
      }
    };
  }, []);

  // event listeners + initial snapshot load
  // dismiss context menu on outside click
  useEffect(() => {
    if (!contextMenu) return;
    const close = () => setContextMenu(null);
    window.addEventListener("pointerdown", close);
    return () => window.removeEventListener("pointerdown", close);
  }, [contextMenu]);

  // keyboard shortcuts — intentionally no deps so closures are always fresh
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isEditableShortcutTarget(e.target)) return;

      // Dialogs own the keyboard while open. This prevents capture, mode, and
      // window shortcuts from mutating the app behind an aria-modal surface.
      if (modalVisibility.pairingOpen || modalVisibility.settingsOpen) return;

      if (e.repeat) return;

      const key = e.key.toLowerCase();

      if (key === "escape") {
        if (contextMenu || settingsOpen) {
          e.preventDefault();
          setContextMenu(null);
          setSettingsOpen(false);
        } else {
          void getCurrentWindow().isFullscreen().then((fullscreen) => {
            if (fullscreen) {
              e.preventDefault();
              return getCurrentWindow().setFullscreen(false);
            }
          }).catch((error) => setCommandError(fmtError(error)));
        }
        return;
      }

      if (key === "f1" && !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey) {
        e.preventDefault();
        setDiagExpanded((value) => !value);
        if (appMode === "minimal") {
          void goConsole();
        }
        return;
      }

      if (!e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey) {
        if (key === "f") {
          e.preventDefault();
          void toggleFullscreen();
        } else if (key === "m") {
          e.preventDefault();
          toggleAudio();
        } else if (key === "h" && appMode === "minimal") {
          e.preventDefault();
          setMinimalChromeHidden((value) => !value);
        }
        return;
      }

      if (!e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return;

      switch (key) {
        case "s":
          e.preventDefault();
          void doCapture();
          break;
        case "r":
          e.preventDefault();
          void doRecordToggle();
          break;
        case "f":
          e.preventDefault();
          void toggleFullscreen();
          break;
        case "m":
          e.preventDefault();
          void (appMode === "console" ? goMinimal() : goConsole());
          break;
        case ",":
          e.preventDefault();
          openSettings("general");
          break;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  // ── commands ──────────────────────────────────────────────────────────────

  function clearAutoReconnectTimer() {
    if (reconnectTimerRef.current !== null) {
      window.clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
    setReconnectNextRetryAt(null);
  }

  async function runSessionCommand(command: Extract<SessionCommand, "start_session" | "reconnect_session" | "stop_session">, silent = false) {
    setPendingSessionCommand(command);
    setCommandPending(true);
    if (!silent) {
      setCommandError(null);
    }

    try {
      let nextSession: SessionSnapshot;
      if (command === "stop_session") {
        nextSession = await invoke<SessionSnapshot>(command);
      } else {
        nextSession = await invoke<SessionSnapshot>(command, {
          receiverName: receiverDisplayName,
          requireLocalApproval: appPreferences.receiverAccessMode === "ask",
          requireKnownDevice: appPreferences.receiverAccessMode === "known-only",
        });
      }
      setSession(nextSession);
      setBonjourStatus(await invoke<BonjourStatusSnapshot>("get_bonjour_status"));
      return true;
    } catch (error) {
      void invoke<BonjourStatusSnapshot>("get_bonjour_status")
        .then(setBonjourStatus)
        .catch(() => undefined);
      if (!silent) {
        setCommandError(fmtError(error));
      }
      return false;
    } finally {
      setPendingSessionCommand(null);
      setCommandPending(false);
    }
  }

  async function refreshBonjourStatus() {
    let refreshError: unknown = null;
    let runtime: ReceiverRuntimeSnapshot | null = null;
    try {
      runtime = await invoke<ReceiverRuntimeSnapshot>("refresh_receiver_readiness", {
        receiverName: receiverDisplayName,
      });
    } catch (error) {
      refreshError = error;
    }
    const status = await invoke<BonjourStatusSnapshot>("get_bonjour_status");

    setBonjourStatus(status);
    if (runtime) setReceiverRuntime(runtime);
    if (refreshError) throw refreshError;
    return status;
  }

  async function refreshTrustedDevices() {
    const devices = await invoke<TrustedDevice[]>("get_trusted_devices");
    setTrustedDevices(devices);
    return devices;
  }

  async function refreshConnectionHistory() {
    const history = await invoke<ConnectionHistoryEntry[]>("get_connection_history");
    setConnectionHistory(history);
    return history;
  }

  async function trustCurrentDevice() {
    setCommandPending(true);
    setCommandError(null);

    try {
      setTrustedDevices(await invoke<TrustedDevice[]>("trust_current_device"));
    } catch (error) {
      setCommandError(fmtError(error));
    } finally {
      setCommandPending(false);
    }
  }

  async function forgetTrustedDevice(deviceKey: string) {
    setCommandPending(true);
    setCommandError(null);

    try {
      setTrustedDevices(await invoke<TrustedDevice[]>("forget_trusted_device", { deviceKey }));
      await refreshConnectionHistory();
    } catch (error) {
      setCommandError(fmtError(error));
    } finally {
      setCommandPending(false);
    }
  }

  async function resetTrustedDevices() {
    setCommandPending(true);
    setCommandError(null);

    try {
      setTrustedDevices(await invoke<TrustedDevice[]>("reset_trusted_devices"));
      await refreshConnectionHistory();
    } catch (error) {
      setCommandError(fmtError(error));
    } finally {
      setCommandPending(false);
    }
  }

  async function confirmPairingTrust(rememberDevice: boolean) {
    setCommandPending(true);
    setCommandError(null);

    try {
      setPairing(await invoke<PairingSnapshot>("confirm_pairing_trust", { rememberDevice }));
    } catch (error) {
      setCommandError(fmtError(error));
    } finally {
      setCommandPending(false);
    }
  }

  async function cancelPairing() {
    setCommandPending(true);
    setCommandError(null);

    try {
      setPairing(await invoke<PairingSnapshot>("cancel_pairing"));
    } catch (error) {
      setCommandError(fmtError(error));
    } finally {
      setCommandPending(false);
    }
  }

  async function renameTrustedDevice(deviceKey: string, nickname: string) {
    setCommandPending(true);
    setCommandError(null);

    try {
      setTrustedDevices(await invoke<TrustedDevice[]>("rename_trusted_device", { deviceKey, nickname: nickname.trim() || null }));
    } catch (error) {
      setCommandError(fmtError(error));
    } finally {
      setCommandPending(false);
    }
  }

  async function setTrustedDeviceBlocked(deviceKey: string, blocked: boolean, reason?: string) {
    setCommandPending(true);
    setCommandError(null);

    try {
      setTrustedDevices(await invoke<TrustedDevice[]>("set_trusted_device_blocked", {
        deviceKey,
        blocked,
        reason: blocked ? reason ?? "Blocked for auto-trust on this PC." : null,
      }));
      await refreshConnectionHistory();
    } catch (error) {
      setCommandError(fmtError(error));
    } finally {
      setCommandPending(false);
    }
  }

  async function exportDiagnostics() {
    setCommandPending(true);
    setCommandError(null);

    try {
      setLastDiagnosticsExport(await invoke<DiagnosticsExport>("export_diagnostics_report", { receiverName: receiverDisplayName }));
      await refreshConnectionHistory();
    } catch (error) {
      setCommandError(fmtError(error));
    } finally {
      setCommandPending(false);
    }
  }

  async function downloadAvailableUpdate() {
    if (!availableUpdate || updateState === "downloading" || updateState === "ready" || updateState === "installing") {
      return;
    }

    setUpdateState("downloading");
    setUpdateError(null);

    try {
      let prepared = await invoke<AppUpdateInfo | null>("download_app_update");
      if (!prepared) {
        const refreshed = await invoke<AppUpdateInfo | null>("check_for_app_update");
        setAvailableUpdate(refreshed);
        if (refreshed) {
          prepared = await invoke<AppUpdateInfo | null>("download_app_update");
        }
      }
      setAvailableUpdate(prepared ?? availableUpdate);
      setUpdateState(prepared ? "ready" : "available");
      if (!prepared) {
        setUpdateError("The update is no longer available. MirrorSim will check again next time it starts.");
      }
    } catch (error) {
      setUpdateState("available");
      setUpdateError(fmtError(error));
    }
  }

  async function installAvailableUpdate() {
    if (!availableUpdate || updateState !== "ready") {
      return;
    }

    if (import.meta.env.DEV && devUpdatePreview) {
      setUpdateError("Updater install is disabled in local preview mode. Publish a GitHub Release with latest.json to test the real flow.");
      return;
    }

    if (!updateRestartSafe) {
      setUpdateError("Finish the current connection before restarting MirrorSim to update.");
      return;
    }

    setUpdateState("installing");
    setUpdateError(null);

    try {
      const installed = await invoke<AppUpdateInfo | null>("install_app_update");
      if (!installed) {
        setUpdateState("available");
        setUpdateError("The prepared update expired. Retry the download before restarting.");
      }
    } catch (error) {
      setUpdateState("ready");
      setUpdateError(fmtError(error));
    }
  }

  async function startSessionFlow(command: "start_session" | "reconnect_session", source: "manual" | "auto") {
    shouldMaintainConnectionRef.current = true;
    if (source === "manual") {
      hasReachedLiveSessionRef.current = false;
      setReconnectUiState(null);
      clearAutoReconnectTimer();
      reconnectAttemptRef.current = 0;
    }
    const ok = await runSessionCommand(command, source === "auto");
    if (!ok) {
      if (source === "manual") {
        shouldMaintainConnectionRef.current = false;
      }
      try {
        await refreshBonjourStatus();
      } catch {
        // preserve the command error if the readiness refresh also fails
      }
    }
    if (ok && source === "auto") {
      setCommandError(null);
    }
    return ok;
  }

  async function stopSessionFlow() {
    shouldMaintainConnectionRef.current = false;
    hasReachedLiveSessionRef.current = false;
    reconnectAttemptRef.current = 0;
    autoReconnectInFlightRef.current = false;
    setReconnectUiState(null);
    clearAutoReconnectTimer();
    await runSessionCommand("stop_session");
  }

  function toggleSettings() {
    if (modalVisibility.pairingOpen) {
      return;
    }
    setSettingsSection("general");
    setSettingsOpen((value) => !value);
  }

  function openSettings(section: SettingsSection) {
    if (modalVisibility.pairingOpen) {
      return;
    }
    setSettingsSection(section);
    setSettingsOpen(true);
  }

  async function checkForUpdatesManually() {
    setCommandPending(true);
    setUpdateState("checking");
    setUpdateError(null);
    setLastUpdateCheckMessage(null);
    setUpdateBannerDismissed(false);

    try {
      if (import.meta.env.DEV && devUpdatePreview) {
        setAvailableUpdate(devUpdatePreview);
        setUpdateState("ready");
        setLastUpdateCheckMessage(`Previewing update ${devUpdatePreview.version}.`);
        return;
      }

      const downloaded = await invoke<AppUpdateInfo | null>("get_downloaded_app_update");
      if (downloaded) {
        setAvailableUpdate(downloaded);
        setUpdateState("ready");
        setLastUpdateCheckMessage(`Update ${downloaded.version} is ready.`);
        return;
      }

      const update = await invoke<AppUpdateInfo | null>("check_for_app_update");
      setAvailableUpdate(update);
      setUpdateState(update ? "available" : "idle");
      setLastUpdateCheckMessage(update ? `Update ${update.version} is available.` : "You're up to date.");
    } catch (error) {
      setUpdateState("idle");
      setUpdateError(fmtError(error));
    } finally {
      setCommandPending(false);
    }
  }

  async function toggleFullscreen() {
    try {
      const appWindow = getCurrentWindow();
      await appWindow.setFullscreen(!(await appWindow.isFullscreen()));
      setCommandError(null);
    } catch (error) {
      setCommandError(`Could not change fullscreen mode: ${fmtError(error)}`);
    }
  }

  function handleDeviceDoubleClick(event: ReactMouseEvent<HTMLDivElement>) {
    if (event.target instanceof HTMLElement && event.target.closest("button, input, textarea, select, [contenteditable='true']")) {
      return;
    }

    void toggleFullscreen();
  }

  function isEditableShortcutTarget(target: EventTarget | null) {
    if (!(target instanceof HTMLElement)) {
      return false;
    }

    return Boolean(target.closest("input, textarea, select, [contenteditable='true']"));
  }

  function doPrimary() {
    if (runtimeInitializing) return;
    if (ss === "idle") {
      void primeAudio();
    }
    if (recordingBusy) {
      void doRecordToggle();
    }
    else if (ss === "idle") void startSessionFlow("start_session", "manual");
    else void stopSessionFlow();
  }

  function toggleAudio() {
    if (!audioAvailable) return;
    const willUnmute = appPreferences.audioMuted;
    setAppPreference("audioMuted", !appPreferences.audioMuted);
    if (willUnmute || audioState === "suspended") {
      void primeAudio();
    }
  }

  const bonjourToneClass =
    bonjourStatus.status === "missing"
      ? "border-amber-400/20 bg-amber-500/10 text-amber-100"
      : bonjourStatus.status === "stopped"
        ? "border-orange-400/20 bg-orange-500/10 text-orange-100"
        : "border-white/7 bg-[#15161a] text-white/75";

  useEffect(() => {
    if (!appPreferences.autoReconnectOnDrop
      || !shouldMaintainConnectionRef.current
      || !hasReachedLiveSessionRef.current
      || recordingBusy) {
      return;
    }

    const lostConnection = ss === "idle" && Boolean(receiverRuntime.lastError);
    if (!lostConnection) {
      return;
    }

    if (commandPending || autoReconnectInFlightRef.current || reconnectTimerRef.current !== null) {
      return;
    }

    const attempt = reconnectAttemptRef.current + 1;
    if (attempt > 5) {
      shouldMaintainConnectionRef.current = false;
      setReconnectUiState(null);
      setReconnectNextRetryAt(null);
      setCommandError("MirrorSim could not reconnect after 5 attempts. Start listening again when the phone and network are ready.");
      return;
    }
    const delayMs = Math.min(8000, 1000 * 2 ** Math.min(attempt - 1, 3));
    const nextRetryAt = Date.now() + delayMs;

    setReconnectUiState({ attempt, phase: "scheduled" });
    setReconnectNextRetryAt(nextRetryAt);

    reconnectTimerRef.current = window.setTimeout(() => {
      reconnectTimerRef.current = null;
      setReconnectUiState({ attempt, phase: "retrying" });
      setReconnectNextRetryAt(null);
      reconnectAttemptRef.current = attempt;
      autoReconnectInFlightRef.current = true;

      void startSessionFlow("reconnect_session", "auto").finally(() => {
        autoReconnectInFlightRef.current = false;
      });
    }, delayMs);
  }, [appPreferences.autoReconnectOnDrop, commandPending, receiverRuntime.lastError, recordingBusy, ss]);

  function adjustZoom(delta: 1 | -1) {
    setZoom((prev) => {
      const idx = ZOOM_LEVELS.indexOf(prev);
      return ZOOM_LEVELS[Math.max(0, Math.min(ZOOM_LEVELS.length - 1, idx + delta))] ?? prev;
    });
  }

  const latestSavedCapture = [...captures].reverse().find((capture) => capture.type === "screenshot" && capture.filePath);
  const updateHeadline = availableUpdate
    ? import.meta.env.DEV && devUpdatePreview
      ? `Preview update ${availableUpdate.version}`
      : updateState === "downloading"
        ? `Downloading update ${availableUpdate.version}`
        : updateState === "installing"
          ? `Restarting into update ${availableUpdate.version}`
          : updateState === "available"
            ? `Update ${availableUpdate.version} needs attention`
            : `Update ${availableUpdate.version} is ready`
    : null;
  const updateStatusDetail = updateState === "downloading"
    ? "Downloading and verifying in the background."
    : updateState === "available"
      ? "The background download did not finish."
      : updateState === "installing"
        ? "MirrorSim will close, apply the signed update, and reopen."
        : updateState === "ready"
          ? updateRestartSafe
            ? "Downloaded and verified."
            : "Ready after the current session ends."
          : null;

  function renderUpdateBanner(compact = false) {
    if (!availableUpdate || updateBannerDismissed) {
      return null;
    }

    const isDevPreview = Boolean(import.meta.env.DEV && devUpdatePreview);
    const compactLabel = updateState === "ready" && !updateRestartSafe
      ? "Update ready after session"
      : isDevPreview
        ? `Update ${availableUpdate.version} preview`
        : updateState === "downloading"
        ? `Downloading ${availableUpdate.version}`
        : updateState === "installing"
          ? "Restarting MirrorSim"
          : updateState === "available"
            ? "Update download failed"
            : `${availableUpdate.version} ready`;
    const statusDotClass = updateState === "available"
      ? "bg-amber-300"
      : updateState === "ready"
        ? "bg-emerald-300"
        : updateState === "downloading" || updateState === "installing"
          ? "animate-pulse bg-cyan-300"
          : "bg-white/35";
    const showPrimaryAction = updatePrimaryAction.kind !== "none";

    if (compact) {
      return (
        <div
          role="status"
          aria-live="polite"
          className="flex max-w-[calc(100vw-16px)] items-center gap-2 rounded-full border border-white/10 bg-[#15171b]/94 py-1.5 pl-2.5 pr-1.5 text-white/80 shadow-lg backdrop-blur-md"
          title={updateError ?? updatePrimaryAction.title ?? updateStatusDetail ?? undefined}
        >
          <span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", statusDotClass)} aria-hidden="true" />
          <span className="truncate text-[10px] font-medium">{compactLabel}</span>
          {showPrimaryAction && (
            <button
              type="button"
              className="inline-flex shrink-0 items-center justify-center rounded-full bg-white/9 px-2.5 py-1 text-[10px] font-semibold text-white transition hover:bg-white/14 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300/70"
              onClick={() => {
                if (updatePrimaryAction.kind === "download") {
                  void downloadAvailableUpdate();
                } else {
                  void installAvailableUpdate();
                }
              }}
              title={updatePrimaryAction.title}
            >
              {updatePrimaryAction.kind === "install" ? "Restart" : "Retry"}
            </button>
          )}
          <button
            type="button"
            className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-sm text-white/38 transition hover:bg-white/8 hover:text-white/75 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300/70"
            onClick={() => setUpdateBannerDismissed(true)}
            title="Hide until next launch"
            aria-label="Hide update until next launch"
          >
            ×
          </button>
        </div>
      );
    }

    return (
      <div
        role="status"
        aria-live="polite"
        className="rounded-lg border border-white/8 bg-white/2.5 px-2.5 py-2 text-white/75"
      >
        <div className="flex items-start gap-2.5">
          <span className={cn("mt-1 h-1.5 w-1.5 shrink-0 rounded-full", statusDotClass)} aria-hidden="true" />
          <div className="min-w-0 flex-1">
            <div className="truncate text-[11px] font-medium text-white/85">{updateHeadline}</div>
            {updateStatusDetail && <p className="mt-0.5 text-[10px] leading-4 text-white/45">{updateStatusDetail}</p>}
            {updateError && <p className="mt-0.5 wrap-break-word text-[10px] leading-4 text-amber-200/80">{updateError}</p>}
          </div>
          {showPrimaryAction && (
            <button
              type="button"
              className="inline-flex shrink-0 items-center justify-center rounded-[5px] border border-white/10 bg-white/5 px-2 py-1 text-[10px] font-semibold text-white/80 transition hover:border-white/15 hover:bg-white/9 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300/70"
              onClick={() => {
                if (updatePrimaryAction.kind === "download") {
                  void downloadAvailableUpdate();
                } else {
                  void installAvailableUpdate();
                }
              }}
              title={updatePrimaryAction.title}
            >
              {updatePrimaryAction.label}
            </button>
          )}
        </div>
        <div className="ml-4 mt-1 flex items-center gap-3">
          <button
            type="button"
            className="text-[10px] text-white/35 underline decoration-white/15 underline-offset-2 transition hover:text-white/65 focus-visible:rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300/70"
            onClick={() => void openUrl(releasePageUrl).catch((error) => setCommandError(fmtError(error)))}
          >
            Release details
          </button>
          <button
            type="button"
            className="text-[10px] text-white/35 transition hover:text-white/65 focus-visible:rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300/70"
            onClick={() => setUpdateBannerDismissed(true)}
          >
            Later
          </button>
        </div>
      </div>
    );
  }

  function renderSettingsModal(embedded = false) {
    return (
    <SettingsModal
      open={modalVisibility.settingsOpen}
      embedded={embedded}
      initialSection={settingsSection}
      appPreferences={appPreferences}
      screenshotSettings={screenshotSettings}
      recordingSettings={recordingSettings}
      session={session}
      trustedDevices={trustedDevices}
      connectionHistory={connectionHistory}
      bonjourStatus={bonjourStatus}
      receiverRuntime={receiverRuntime}
      commandPending={commandPending}
      receiverDisplayName={receiverDisplayName}
      lastDiagnosticsExport={lastDiagnosticsExport}
      previewPresetDescription={previewPreset.description}
      appVersion={appVersion}
      updateStatus={lastUpdateCheckMessage ?? (availableUpdate ? `Version ${availableUpdate.version} is ${updateState}.` : updateState === "checking" ? "Checking…" : "Automatic checks enabled")}
      updateError={updateError}
      audioAvailable={audioAvailable}
      audioStatus={audioError ? `Audio error: ${audioError}` : audioState === "suspended" ? "Click the speaker control once to enable playback." : audioState === "playing" ? "Receiving iPhone audio." : "Ready for iPhone audio."}
      senderVolumeSupported={senderVolumeSupported}
      senderVolumeDb={receiverRuntime.senderVolumeDb}
      effectiveAudioVolume={effectiveVolume}
      onClose={() => setSettingsOpen(false)}
      setAppPreference={setAppPreference}
      setScreenshotSetting={setScreenshotSetting}
      setRecordingSetting={setRecordingSetting}
      onChooseScreenshotFolder={() => void chooseScreenshotFolder().catch((error) => setCommandError(fmtError(error)))}
      onChooseRecordingFolder={() => void chooseRecordingFolder().catch((error) => setCommandError(fmtError(error)))}
      onTrustCurrentDevice={() => void trustCurrentDevice()}
      onForgetTrustedDevice={(deviceKey) => void forgetTrustedDevice(deviceKey)}
      onRenameTrustedDevice={(deviceKey, nickname) => void renameTrustedDevice(deviceKey, nickname)}
      onSetTrustedDeviceBlocked={(deviceKey, blocked, reason) => void setTrustedDeviceBlocked(deviceKey, blocked, reason)}
      onResetTrustedDevices={() => void resetTrustedDevices()}
      onRefreshBonjourStatus={() => void refreshBonjourStatus().catch((error) => setCommandError(fmtError(error)))}
      onOpenWindowsFirewall={() => void invoke("open_windows_firewall").catch((error) => setCommandError(fmtError(error)))}
      onExportDiagnostics={() => void exportDiagnostics()}
      onCheckForUpdates={() => void checkForUpdatesManually()}
      onOpenProject={() => void openUrl(projectPageUrl).catch((error) => setCommandError(fmtError(error)))}
      onOpenIssues={() => void openUrl(issuesPageUrl).catch((error) => setCommandError(fmtError(error)))}
      onOpenLicense={() => void openUrl(licensePageUrl).catch((error) => setCommandError(fmtError(error)))}
      onOpenThirdPartyNotices={() => void openUrl(thirdPartyNoticesUrl).catch((error) => setCommandError(fmtError(error)))}
    />
    );
  }

  function renderPairingModal(embedded = false) {
    return (
    <PairingModal
      pairing={pairing}
      approvalActionSupported={approvalActionSupported}
      rememberTrustByDefault={appPreferences.receiverAccessMode === "remember-trusted"}
      commandPending={commandPending}
      embedded={embedded}
      onConfirmTrust={() => void confirmPairingTrust(appPreferences.receiverAccessMode === "remember-trusted")}
      onCancel={() => void cancelPairing()}
    />
    );
  }

  const settingsModal = renderSettingsModal();

  const diagnosticsItems: Array<[string, string]> = [
    ["State", ss],
    ["Preset", previewPreset.label],
    ["FPS", String(preview.fps)],
    ["Bitrate", `${(preview.bitrateKbps / 1000).toFixed(1)} Mbps`],
    ["Latency", `${preview.latencyMs} ms`],
    ["Source", videoDiag.videoWidth > 0 && videoDiag.videoHeight > 0
      ? `${videoDiag.videoWidth}x${videoDiag.videoHeight}`
      : previewClientDiag.playbackBackend === "webcodecs" && previewStream
        ? `${previewStream.codedWidth}x${previewStream.codedHeight}`
        : "waiting"],
    ["Frames", String(preview.frameNumber)],
    ["Playback", `${videoDiag.currentTime.toFixed(2)}s / ${videoDiag.bufferedEnd.toFixed(2)}s`],
    ["Video state", `${videoDiag.paused ? "paused" : "playing"}, ready ${videoDiag.readyState}`],
    ["Decoded", String(videoDiag.totalVideoFrames)],
    ["Buffer", `+${bufferedAhead.toFixed(2)}s`],
    ["Rate", `${videoDiag.playbackRate.toFixed(2)}x`],
    ["Dropped", String(videoDiag.droppedVideoFrames)],
    ["Queued", String(previewDiag.queuedSegments)],
    ["Init", previewDiag.initSegmentReady ? "ready" : "waiting"],
    ["Playback backend", previewClientDiag.playbackBackend ?? "waiting"],
    ["Appended", String(previewClientDiag.mediaAppendCount)],
    [previewClientDiag.playbackBackend === "webcodecs" ? "Decoder output" : "MSE ranges",
      previewClientDiag.playbackBackend === "webcodecs"
        ? `${previewClientDiag.decodedOutputCount} decoded / ${previewClientDiag.presentedFrameCount} presented (queue ${previewClientDiag.decoderQueueSize})`
        : `${previewClientDiag.bufferedRangeCount} (${previewClientDiag.bufferedStart.toFixed(2)}s-${previewClientDiag.bufferedEnd.toFixed(2)}s)`],
    ["Last keyframe", previewClientDiag.lastKeyframeSequenceNumber === null
      ? "waiting"
      : `segment ${previewClientDiag.lastKeyframeSequenceNumber} (${previewClientDiag.segmentsSinceKeyframe} since)`],
    ["Empty appends", String(previewClientDiag.emptyBufferedAppendCount)],
    ["Media event", previewClientDiag.lastMediaEvent ?? "waiting"],
    ["Canvas", previewClientDiag.canvasConnected
      ? `mounted, ${previewClientDiag.canvasContextLossCount} context losses`
      : "detached"],
    ["Pixel probe", previewClientDiag.pixelProbeAverageLuma === null || previewClientDiag.pixelProbeDarkRatio === null
      ? "waiting"
      : `avg ${previewClientDiag.pixelProbeAverageLuma.toFixed(1)}, ${Math.round(previewClientDiag.pixelProbeDarkRatio * 100)}% dark, ${previewClientDiag.decodedFrameFormat ?? "unknown format"}`],
    ["Picture availability", videoAvailabilityNotice === "sender-paused"
      ? "sender paused video while audio continued"
      : videoAvailabilityNotice === "possible-protected"
        ? "possible protected surface (advancing black video with audible audio)"
        : "normal"],
    ["Media error", previewClientDiag.lastMediaError ?? "none"],
    ["Errors", String(previewClientDiag.appendErrorCount)],
    ["Recoveries", `${videoRecoveryCount} playback / ${previewClientDiag.decoderClientRecoveryCount} decoder-client`],
    ["Discovery", bonjourStatus.status],
    ["Transport", receiverRuntime.transport],
    ["Config generation", String(previewStream?.configGeneration ?? 0)],
    ["Audio", audioError ?? (audioAvailable ? `${audioState} · ${Math.round(effectiveVolume * 100)}% effective` : "unavailable")],
    ["iPhone volume", receiverRuntime.senderVolumeDb === null ? "not reported" : `${receiverRuntime.senderVolumeDb.toFixed(1)} dB`],
    ["Phone orientation", receiverRuntime.videoGeometry ? `${receiverRuntime.videoGeometry.orientation} · source ${receiverRuntime.videoGeometry.sourceWidth}×${receiverRuntime.videoGeometry.sourceHeight} · video ${receiverRuntime.videoGeometry.outputWidth}×${receiverRuntime.videoGeometry.outputHeight}` : "not reported"],
    ["Last error", receiverRuntime.lastError ?? surfaceError ?? commandError ?? "—"],
  ];
  const previewResolutionLabel = videoDiag.videoWidth > 0 && videoDiag.videoHeight > 0
    ? `${videoDiag.videoWidth}×${videoDiag.videoHeight}`
    : previewStream
      ? `${previewStream.codedWidth}×${previewStream.codedHeight}`
      : "—";

  const consoleDeviceFrame = (
    <DeviceFrame
      appMode={appMode}
      deviceFrameWidth={deviceFrameWidth}
      deviceWidthClass={deviceWidthClass}
      orientation={orientation}
      screenFrameClass={screenFrameClass}
      screenshotFlashActive={screenshotFlashActive}
      sessionState={pendingSessionCommand === "start_session" || pendingSessionCommand === "reconnect_session" ? "discovering" : ss}
      isLive={isLive}
      isIdle={isIdle}
      isRec={recordingBusy}
      recElapsed={recElapsed}
      bonjourNeedsAttention={bonjourNeedsAttention}
      sessionHeadline={sessionHeadline}
      sessionSupportingText={sessionSupportingText}
      compactIdlePresentation
      showPhoneSteps={false}
      phoneSteps={connectionPresentation.phoneSteps}
      primarySessionActionLabel={primarySessionActionLabel}
      primarySessionActionDisabled={primarySessionActionDisabled}
      onPrimary={doPrimary}
      previewStatus={surfaceStatus}
      previewError={surfaceError}
      onRetryPreview={retryPreview}
      videoAvailabilityNotice={protectedVideoNoticeDismissed ? null : videoAvailabilityNotice}
      onDismissProtectedVideoNotice={() => setProtectedVideoNoticeDismissed(true)}
      previewDimClass={previewDimClass}
      previewVideoStyle={previewVideoStyle}
      tone={tone}
      overlay={renderPairingModal(true)}
      onDoubleClick={handleDeviceDoubleClick}
      setVideoHost={setVideoHost}
    />
  );

  const minimalDeviceFrame = (
    <DeviceFrame
      appMode={appMode}
      deviceFrameWidth={deviceFrameWidth}
      deviceWidthClass={deviceWidthClass}
      orientation={orientation}
      screenFrameClass={screenFrameClass}
      screenshotFlashActive={screenshotFlashActive}
      sessionState={pendingSessionCommand === "start_session" || pendingSessionCommand === "reconnect_session" ? "discovering" : ss}
      isLive={isLive}
      isIdle={isIdle}
      isRec={recordingBusy}
      recElapsed={recElapsed}
      bonjourNeedsAttention={bonjourNeedsAttention}
      sessionHeadline={sessionHeadline}
      sessionSupportingText={sessionSupportingText}
      showPhoneSteps={connectionPresentation.showPhoneSteps}
      phoneSteps={connectionPresentation.phoneSteps}
      primarySessionActionLabel={primarySessionActionLabel}
      primarySessionActionDisabled={primarySessionActionDisabled}
      onPrimary={doPrimary}
      previewStatus={surfaceStatus}
      previewError={surfaceError}
      onRetryPreview={retryPreview}
      videoAvailabilityNotice={protectedVideoNoticeDismissed ? null : videoAvailabilityNotice}
      onDismissProtectedVideoNotice={() => setProtectedVideoNoticeDismissed(true)}
      previewDimClass={previewDimClass}
      previewVideoStyle={previewVideoStyle}
      tone={tone}
      overlay={modalVisibility.pairingOpen
        ? renderPairingModal(true)
        : modalVisibility.settingsOpen
          ? renderSettingsModal(true)
          : null}
      onDoubleClick={handleDeviceDoubleClick}
      setVideoHost={setVideoHost}
      onContextMenu={(event) => {
        event.preventDefault();
        setContextMenu({ x: event.clientX, y: event.clientY });
      }}
    />
  );

  // ── console view ──────────────────────────────────────────────────────────

  if (appMode === "console") {
    return (
      <>
        <ConsoleView
          panelSurfaceClass={panelSurfaceClass}
          controlButtonClass={controlButtonClass}
          bonjourToneClass={bonjourToneClass}
          bonjourStatus={bonjourStatus}
          bonjourNeedsAttention={bonjourNeedsAttention}
          captures={captures}
          captureNotice={captureNotice}
          canCapture={canCapture}
          canRecord={canRecord}
          audioAvailable={audioAvailable}
          audioMuted={appPreferences.audioMuted}
          commandPending={commandPending}
          commandError={commandError}
          currentDeviceTrusted={session.currentDeviceTrusted}
          currentDeviceVisible={session.currentDeviceKey !== null}
          deviceFrame={consoleDeviceFrame}
          diagExpanded={diagExpanded}
          diagnosticsItems={diagnosticsItems}
          isLive={isLive}
          isRec={recordingBusy}
          phoneSteps={connectionPresentation.phoneSteps}
          showPhoneSteps={connectionPresentation.showPhoneSteps}
          sessionTone={connectionPresentation.tone}
          onAdjustZoom={adjustZoom}
          onCapture={() => void doCapture()}
          onToggleAudio={toggleAudio}
          onGoMinimal={() => void goMinimal()}
          onOpenSettings={toggleSettings}
          onOpenDevicesSettings={() => openSettings("devices")}
          onPrimary={doPrimary}
          onRecordToggle={() => void doRecordToggle()}
          onRefreshBonjourStatus={() => void refreshBonjourStatus().catch((error) => setCommandError(fmtError(error)))}
          onRevealCapture={(capture) => void revealCaptureInExplorer(capture).catch((error) => setCommandError(fmtError(error)))}
          onRetryConnection={() => void startSessionFlow("reconnect_session", "manual")}
          onRotate={() => setOrientation((value) => (value === "portrait" ? "landscape" : "portrait"))}
          onStartWindowDrag={startWindowDrag}
          onTrustCurrentDevice={() => void trustCurrentDevice()}
          onToggleDiagnostics={() => setDiagExpanded((value) => !value)}
          onToggleFullscreen={toggleFullscreen}
          orientation={orientation}
          previewFps={preview.fps}
          previewLatencyMs={preview.latencyMs}
          previewBitrateKbps={preview.bitrateKbps}
          previewPresetLabel={previewPreset.label}
          previewResolutionLabel={previewResolutionLabel}
          primarySessionActionDisabled={primarySessionActionDisabled}
          primarySessionActionLabel={primarySessionActionLabel}
          recElapsed={recElapsed}
          reconnectBadge={renderReconnectBadge()}
          sessionHeadline={sessionHeadline}
          sessionSecondaryLabel={sessionSecondaryLabel}
          sessionSupportingText={sessionSupportingText}
          showRetryConnection={showRetryConnection}
          settingsOpen={modalVisibility.settingsOpen}
          settingsModal={settingsModal}
          technicalDetails={renderTechnicalDetails()}
          trustedDevicesCount={trustedDevices.length}
          updateBanner={renderUpdateBanner()}
          zoom={zoom}
          zoomIndex={zoomIndex}
          zoomMaxIndex={ZOOM_LEVELS.length - 1}
        />
      </>
    );
  }

  // ── minimal view ──────────────────────────────────────────────────────────

  return (
    <>
      <MinimalView
        canCapture={canCapture}
        canRecord={canRecord}
        audioAvailable={audioAvailable}
        audioMuted={appPreferences.audioMuted}
        captureNotice={captureNotice}
        commandError={commandError}
        commandPending={commandPending}
        contextMenu={(
          <MinimalContextMenu
            canCapture={canCapture}
            canRecord={canRecord}
            chromeHidden={minimalChromeHidden}
            contextMenu={contextMenu}
            isRec={recordingBusy}
            latestSavedCapture={latestSavedCapture}
            onCapture={() => void doCapture()}
            onClose={() => setContextMenu(null)}
            onCopyToClipboard={() => void doCapture({ copyToClipboard: true, saveToDisk: false })}
            onGoConsole={() => void goConsole()}
            onOpenInExplorer={() => void revealCaptureInExplorer(latestSavedCapture).catch((error) => setCommandError(fmtError(error)))}
            onOpenSettings={() => openSettings("capture")}
            onRecordToggle={() => void doRecordToggle()}
            onSaveToDocuments={() => void doCapture({ saveToDisk: true, copyToClipboard: false, saveLocation: "documents" })}
            onToggleChrome={() => setMinimalChromeHidden((value) => !value)}
            onZoomIn={() => adjustZoom(1)}
            onZoomOut={() => adjustZoom(-1)}
            onZoomReset={() => setZoom(1)}
            zoomCanIncrease={ZOOM_LEVELS.indexOf(zoom) !== ZOOM_LEVELS.length - 1}
            zoomCanDecrease={ZOOM_LEVELS.indexOf(zoom) !== 0}
          />
        )}
        deviceFrame={minimalDeviceFrame}
        chromeHidden={minimalChromeHidden}
        isRec={recordingBusy}
        minimalFloatingButtonClass={minimalFloatingButtonClass}
        minimalShellRef={minimalShellRef}
        onCapture={() => void doCapture()}
        onToggleAudio={toggleAudio}
        onFit={() => {
          void fitMinimalWindow(orientation);
        }}
        onGoConsole={() => void goConsole()}
        onOpenSettings={toggleSettings}
        onRecordToggle={() => void doRecordToggle()}
        onRotate={() => {
          setOrientation((value) => {
            const next = value === "portrait" ? "landscape" : "portrait";
            if (appMode === "minimal") {
              window.requestAnimationFrame(() => {
                window.requestAnimationFrame(() => {
                  void fitMinimalWindow(next);
                });
              });
            }
            return next;
          });
        }}
        onStartWindowDrag={startWindowDrag}
        orientation={orientation}
        reconnectBadge={renderReconnectBadge(true)}
        settingsOpen={modalVisibility.settingsOpen}
        settingsModal={null}
        showConsoleBadge={shouldShowUpdateBadge}
        shellWidth={MINIMAL_SHELL_WIDTH[orientation]}
        titlebarStateDotClass={cn("h-1.5 w-1.5 rounded-full", titlebarStateDotClass)}
        titlebarStateLabel={titlebarStateLabel}
        updateBanner={renderUpdateBanner(true)}
        zoom={zoom}
      />
    </>
  );
}
