import { useEffect, useRef, useState, type CSSProperties } from "react";
import { invoke } from "@tauri-apps/api/core";
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
  formatAppleDeviceModel,
  fmtError,
} from "@/features/mirrorsim/helpers";
import { ConsoleView } from "@/features/mirrorsim/components/ConsoleView";
import { DeviceFrame } from "@/features/mirrorsim/components/DeviceFrame";
import { MinimalContextMenu } from "@/features/mirrorsim/components/MinimalContextMenu";
import { MinimalView } from "@/features/mirrorsim/components/MinimalView";
import { PairingModal } from "@/features/mirrorsim/components/PairingModal";
import { SettingsModal } from "@/features/mirrorsim/components/SettingsModal";
import { startWindowDrag } from "@/features/mirrorsim/components/WindowControls";
import { useCaptureActions } from "@/features/mirrorsim/hooks/useCaptureActions";
import { usePreferencesState } from "@/features/mirrorsim/hooks/usePreferencesState";
import { useWindowMode } from "@/features/mirrorsim/hooks/useWindowMode";
import { usePreviewRuntime } from "./features/mirrorsim/hooks/usePreviewRuntime";
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
    currentVersion: import.meta.env.VITE_DEV_UPDATER_CURRENT_VERSION?.trim() || "0.1.0",
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
  const devUpdatePreview = getDevUpdateOverride();
  const [appMode, setAppMode] = useState<AppMode>("minimal");
  const [orientation, setOrientation] = useState<Orientation>("portrait");
  const [zoom, setZoom] = useState<ZoomLevel>(1);
  const [commandPending, setCommandPending] = useState(false);
  const [commandError, setCommandError] = useState<string | null>(null);
  const [diagExpanded, setDiagExpanded] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [contextMenu, setContextMenu] = useState<ContextMenuPos | null>(null);
  const [captures, setCaptures] = useState<Capture[]>([]);
  const [trustedDevices, setTrustedDevices] = useState<TrustedDevice[]>([]);
  const [connectionHistory, setConnectionHistory] = useState<ConnectionHistoryEntry[]>([]);
  const [lastDiagnosticsExport, setLastDiagnosticsExport] = useState<DiagnosticsExport | null>(null);
  const [availableUpdate, setAvailableUpdate] = useState<AppUpdateInfo | null>(null);
  const [updateState, setUpdateState] = useState<"idle" | "checking" | "available" | "installing" | "disabled">("idle");
  const [updateError, setUpdateError] = useState<string | null>(null);
  const [screenshotFlashActive, setScreenshotFlashActive] = useState(false);
  const [reconnectUiState, setReconnectUiState] = useState<{ attempt: number; phase: "scheduled" | "retrying" } | null>(null);
  const [reconnectNextRetryAt, setReconnectNextRetryAt] = useState<number | null>(null);
  const shouldMaintainConnectionRef = useRef(false);
  const reconnectAttemptRef = useRef(0);
  const reconnectTimerRef = useRef<number | null>(null);
  const autoReconnectInFlightRef = useRef(false);
  const startupPreferencesAppliedRef = useRef(false);
  const autoDiscoveryAttemptedRef = useRef(false);
  const updateCheckAttemptedRef = useRef(false);

  const {
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
  } = usePreferencesState();

  const {
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
    surfaceStatus,
    surfaceError,
    videoEl,
    setVideoEl,
  } = usePreviewRuntime({
    previewPreset: PREVIEW_QUALITY_PRESETS[appPreferences.previewQualityPreset],
    setCommandError,
  });

  const { minimalShellRef, fitMinimalWindow, goMinimal, goConsole } = useWindowMode({
    appMode,
    setAppMode,
    orientation,
    setZoom,
    keepMinimalOnTop: appPreferences.keepMinimalOnTop,
    useOpaqueWindowBackground: appPreferences.useOpaqueWindowBackground,
    setCommandError,
  });

  const {
    recElapsed,
    chooseScreenshotFolder,
    chooseRecordingFolder,
    revealCaptureInExplorer,
    doCapture,
    doRecordToggle,
  } = useCaptureActions({
    appPreferences,
    canCapture: session.status === "mirroring" || session.status === "recording",
    canRecord: session.status === "mirroring" || session.status === "recording",
    isRec: session.status === "recording",
    recordingSettings,
    screenshotSettings,
    setCaptures,
    setCommandError,
    setCommandPending,
    setRecordingSettings,
    setScreenshotFlashActive,
    setScreenshotSettings,
    setSession,
    videoEl,
  });

  // derived
  const ss = session.status;
  const isIdle = ss === "idle";
  const isConnected = ss !== "idle";
  const isLive = ss === "mirroring" || ss === "recording";
  const isRec = ss === "recording";
  const isTransitioningSession = ss === "discovering" || ss === "connecting";
  const bonjourNeedsAttention = bonjourStatus.status === "missing" || bonjourStatus.status === "stopped";
  const receiverTransportLabel = receiverRuntime.transport === "airplayserver" ? "AirPlay transport" : "Fixture transport";
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
  const receiverIdentityLabel = session.receiverId
    ? `${session.receiverId}${session.receiverProtocolVersion ? ` v${session.receiverProtocolVersion}` : ""}`
    : null;
  const receiverDisplayName = appPreferences.receiverDisplayName.trim() || "MirrorSim";
  const supportsPairingTrustControl = session.receiverCapabilities.includes("pairing-trust-control");
  const approvalActionSupported = pairing.canTrust || supportsPairingTrustControl;
  const receiverCapabilityLabel = session.receiverCapabilities.includes("native-receiver-process")
    ? "Native receiver"
    : session.receiverCapabilities.length > 0
      ? `${session.receiverCapabilities.length} receiver features`
      : null;
  const pairingNeedsAttention = pairing.phase !== "idle" && pairing.phase !== "paired" && pairing.phase !== "verifying";
  const sessionHeadline = bonjourNeedsAttention
    ? bonjourStatus.status === "missing"
      ? "Bonjour is required"
      : "Bonjour service is stopped"
    : pairingNeedsAttention
      ? pairing.phase === "pin-required"
        ? "AirPlay verification required"
        : pairing.phase === "awaiting-trust"
          ? "Confirm trust"
          : pairing.phase === "verifying"
            ? "Verifying pairing"
            : pairing.phase === "failed"
              ? "Pairing failed"
              : pairing.deviceName ?? session.deviceName
    : isLive
      ? session.currentDeviceNickname ?? session.deviceName
      : ss === "connecting"
        ? "Connecting to iPhone"
        : ss === "discovering"
          ? "Looking for your iPhone"
          : "Ready to mirror";
  const sessionSupportingText = bonjourNeedsAttention
    ? bonjourStatus.detail
    : pairing.phase === "pin-required"
      ? pairing.prompt
        ?? "This sender is asking for AirPlay verification outside MirrorSim. Cancel if you do not want to continue from this laptop."
      : pairing.phase === "awaiting-trust"
        ? pairing.prompt ?? (appPreferences.receiverAccessMode === "remember-trusted"
          ? "Approve the trust request so MirrorSim remembers this iPhone on this PC."
          : "Approve the trust request for this session only. MirrorSim will ask again next time.")
      : pairing.phase === "verifying"
        ? pairing.prompt ?? "MirrorSim is waiting for the receiver to finish pairing."
      : pairing.phase === "failed"
        ? pairing.failureMessage ?? pairing.prompt ?? "The receiver rejected the current pairing attempt."
    : isRec
      ? "Recording your screen. Stop at any time from the toolbar."
      : isLive
        ? "Your iPhone screen is live."
        : ss === "connecting"
          ? "Connected — waiting for your iPhone to start streaming."
          : ss === "discovering"
            ? "Now on your iPhone:"
            : `Hit Start, then pick ${receiverDisplayName} from your iPhone's Screen Mirroring list.`;
  const sessionSecondaryLabel = isLive
    ? "Connected via AirPlay"
    : pairingNeedsAttention
      ? pairing.deviceId ?? "Pairing in progress"
    : receiverIdentityLabel ?? (receiverRuntime.state === "ready" ? "Ready" : "Status unavailable");
  const currentDeviceTrustLabel = session.currentDeviceKey
    ? session.currentDeviceBlocked
      ? "Blocked on this PC"
      : session.currentDeviceTrusted
        ? "Trusted device"
        : session.currentDeviceKnown
          ? "Known device"
        : pairingNeedsAttention
          ? "Pairing pending"
          : "New device"
    : null;
  const currentDeviceModelLabel = formatAppleDeviceModel(session.currentDeviceModel);
  const currentDeviceOsLabel = session.currentDeviceOsVersion
    ? `${session.currentDeviceOsName ?? "iPhone OS"} ${session.currentDeviceOsVersion}${session.currentDeviceOsBuildVersion ? ` (${session.currentDeviceOsBuildVersion})` : ""}`
    : session.currentDeviceOsName;
  const reconnectAttemptLabel = reconnectUiState && reconnectUiState.attempt > 1 ? ` #${reconnectUiState.attempt}` : "";
  const titlebarStateLabel = isLive
    ? "Connected"
    : reconnectUiState?.phase === "retrying"
      ? `Reconnecting${reconnectAttemptLabel}`
      : isTransitioningSession
        ? "Connecting"
        : "Waiting";
  const titlebarStateDotClass = isLive
    ? "bg-emerald-400"
    : isTransitioningSession
      ? "bg-amber-300"
      : "bg-white/35";
  const primarySessionActionLabel = isIdle
    ? "Start"
    : isRec
      ? "Stop recording"
      : isTransitioningSession
        ? "Cancel"
        : "Disconnect";
  const primarySessionActionDisabled = commandPending || (isIdle && bonjourNeedsAttention);
  const primarySessionActionTitle = isIdle
    ? "Start mirroring"
    : isRec
      ? "Stop recording"
      : isTransitioningSession
        ? "Cancel"
        : "Disconnect";
  const idleTelemetryHint = bonjourNeedsAttention
    ? bonjourStatus.status === "missing"
      ? `Install Bonjour so your iPhone can discover ${receiverDisplayName} on the network.`
      : `Start the Bonjour Service so your iPhone can discover ${receiverDisplayName}.`
    : `Open Control Center on your iPhone, tap Screen Mirroring, then choose ${receiverDisplayName}.`;
  const canCapture = isLive;
  const canRecord = isLive;
  const tone: "inactive" | "live" | "warning" =
    surfaceStatus === "error" || surfaceStatus === "unsupported"
      ? "warning"
      : isLive && surfaceStatus === "ready"
        ? "live"
        : "inactive";
  const bufferedAhead = Math.max(0, videoDiag.bufferedEnd - videoDiag.currentTime);
  const previewPreset = PREVIEW_QUALITY_PRESETS[appPreferences.previewQualityPreset];
  const reconnectCountdownSeconds = reconnectNextRetryAt === null ? null : Math.max(0, Math.ceil((reconnectNextRetryAt - Date.now()) / 1000));
  const releasePageUrl = "https://github.com/Mahcks/MirrorSim/releases/latest";
  const shouldShowUpdateBadge = updateState === "available" || updateState === "installing";
  const zoomIndex = ZOOM_LEVELS.indexOf(zoom);
  const controlButtonClass =
    "inline-flex h-8 w-8 items-center justify-center rounded-[5px] text-white/55 transition hover:bg-[#1a1b1e] hover:text-white disabled:cursor-default disabled:opacity-30";
  const sideButtonClass =
    "inline-flex h-9 w-9 items-center justify-center rounded-[8px] text-white/55 transition hover:bg-[#1a1b1e] hover:text-white disabled:cursor-default disabled:opacity-30";
  const minimalFloatingButtonClass =
    "inline-flex h-7 w-7 cursor-pointer items-center justify-center rounded-lg text-white/65 transition hover:bg-white/8 hover:text-white disabled:cursor-default disabled:opacity-30";
  const panelSurfaceClass =
    "border-white/7 bg-[#131416]";
  const previewDimClass =
    tone === "warning" ? "opacity-[0.08]" : tone === "inactive" ? "opacity-0" : "opacity-100";
  const screenFrameClass = cn(
    "relative overflow-hidden bg-[#050506] shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]",
    orientation === "portrait" ? "aspect-[393/852] rounded-[46px]" : "aspect-[852/393] rounded-[34px]",
    isRec && "shadow-[0_0_0_1.5px_rgba(239,68,68,0.48),0_0_40px_rgba(239,68,68,0.10)]",
  );
  const deviceFrameWidth = DEVICE_RENDER_WIDTH[orientation];
  const deviceWidthClass = orientation === "portrait" ? "rounded-[52px]" : "rounded-[40px]";
  const previewVideoStyle: CSSProperties = {
    imageRendering: previewPreset.imageRendering,
    filter: previewPreset.filter,
  };

  function renderReconnectBadge(compact = false) {
    if (!reconnectUiState || reconnectUiState.phase !== "scheduled") return null;

    const content = `Reconnect${reconnectCountdownSeconds !== null ? ` in ${reconnectCountdownSeconds}s` : " queued"}`;

    return (
      <span
        className={cn(
          "inline-flex items-center gap-1 whitespace-nowrap rounded-full border border-amber-400/20 bg-amber-400/10 text-amber-200",
          compact ? "px-1.5 py-0.5 text-[10px] font-medium tracking-[-0.01em]" : "px-2 py-0.5 text-[11px] font-medium tracking-[-0.01em]",
        )}
      >
        <span className="h-1.5 w-1.5 rounded-full bg-amber-300" />
        {content}
      </span>
    );
  }

  function renderTechnicalDetails() {
    return (
      <details className="group mt-3 border-t border-white/7 pt-3">
        <summary className="cursor-pointer list-none text-[11px] font-medium text-white/40 transition group-open:text-white/65">
          Technical details
        </summary>
        <div className="mt-2 space-y-2 text-[11px]">
          <div className="flex items-center justify-between gap-3">
            <span className="text-white/30">Receiver</span>
            <strong className="max-w-[60%] truncate text-right font-medium text-white/80">{sessionSecondaryLabel}</strong>
          </div>
          <div className="flex items-center justify-between gap-3">
            <span className="text-white/30">Transport</span>
            <strong className="max-w-[60%] truncate text-right font-medium text-white/80">{receiverTransportLabel}</strong>
          </div>
          <div className="flex items-center justify-between gap-3">
            <span className="text-white/30">Receiver state</span>
            <strong className="max-w-[60%] truncate text-right font-medium text-white/80">{receiverStateLabel}</strong>
          </div>
          {previewDeliveryLabel && (
            <div className="flex items-center justify-between gap-3">
              <span className="text-white/30">Preview path</span>
              <strong className="max-w-[60%] truncate text-right font-medium text-white/80">{previewDeliveryLabel}</strong>
            </div>
          )}
          {previewStream?.mimeType && (
            <div className="flex items-center justify-between gap-3">
              <span className="text-white/30">Codec</span>
              <strong className="max-w-[60%] truncate text-right font-medium text-white/80">{previewStream.mimeType}</strong>
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
              <strong className="max-w-[60%] truncate text-right font-medium text-white/80">{currentDeviceTrustLabel}</strong>
            </div>
          )}
          {session.currentDeviceId && (
            <div className="flex items-center justify-between gap-3">
              <span className="text-white/30">Device ID</span>
              <strong className="max-w-[60%] truncate text-right font-medium text-white/80">{session.currentDeviceId}</strong>
            </div>
          )}
          {currentDeviceModelLabel && (
            <div className="flex items-center justify-between gap-3">
              <span className="text-white/30">Model</span>
              <strong className="max-w-[60%] truncate text-right font-medium text-white/80">{currentDeviceModelLabel}</strong>
            </div>
          )}
          {currentDeviceOsLabel && (
            <div className="flex items-center justify-between gap-3">
              <span className="text-white/30">OS</span>
              <strong className="max-w-[60%] truncate text-right font-medium text-white/80">{currentDeviceOsLabel}</strong>
            </div>
          )}
          {session.currentDeviceSourceVersion && (
            <div className="flex items-center justify-between gap-3">
              <span className="text-white/30">AirPlay stack</span>
              <strong className="max-w-[60%] truncate text-right font-medium text-white/80">{session.currentDeviceSourceVersion}</strong>
            </div>
          )}
          {pairingNeedsAttention && (
            <div className="flex items-center justify-between gap-3">
              <span className="text-white/30">Pairing</span>
              <strong className="max-w-[60%] truncate text-right font-medium text-white/80">{pairing.phase}</strong>
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
      setUpdateState("available");
      setUpdateError(null);
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

      void invoke<AppUpdateInfo | null>("check_for_app_update")
        .then((update) => {
          if (cancelled) {
            return;
          }

          setAvailableUpdate(update);
          setUpdateState(update ? "available" : "idle");
        })
        .catch((error) => {
          if (cancelled) {
            return;
          }

          const message = fmtError(error);
          if (/not configured/i.test(message)) {
            setUpdateState("disabled");
            return;
          }

          setUpdateState("idle");
          setUpdateError(message);
        });
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

    if (startupMode === "minimal") {
      void (async () => {
        setAppMode("minimal");
        setZoom(1);
        await fitMinimalWindow(startupOrientation);
      })();
    }
  }, [appPreferences, orientation, preferencesReady]);

  useEffect(() => {
    if (!appPreferences.openDiagnosticsOnError) return;
    if (receiverRuntime.lastError || surfaceError || commandError) {
      setDiagExpanded(true);
    }
  }, [appPreferences.openDiagnosticsOnError, commandError, receiverRuntime.lastError, surfaceError]);

  useEffect(() => {
    if (!appPreferences.autoStartDiscovery || autoDiscoveryAttemptedRef.current || ss !== "idle") {
      return;
    }

    autoDiscoveryAttemptedRef.current = true;
    void startSessionFlow("start_session", "manual");
  }, [appPreferences.autoStartDiscovery, ss]);

  useEffect(() => {
    if (ss !== "idle") {
      shouldMaintainConnectionRef.current = true;
    }

    if (ss === "mirroring" || ss === "recording") {
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
    window.addEventListener("pointerdown", close, { capture: true });
    return () => window.removeEventListener("pointerdown", close, { capture: true });
  }, [contextMenu]);

  // keyboard shortcuts — intentionally no deps so closures are always fresh
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey)) return;
      switch (e.key.toLowerCase()) {
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
          void getCurrentWindow().toggleMaximize();
          break;
        case "m":
          e.preventDefault();
          void (appMode === "console" ? goMinimal() : goConsole());
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
    setCommandPending(true);
    if (!silent) {
      setCommandError(null);
    }

    try {
      if (command === "stop_session") {
        setSession(await invoke<SessionSnapshot>(command));
      } else {
        setSession(await invoke<SessionSnapshot>(command, {
          receiverName: receiverDisplayName,
          requireLocalApproval: appPreferences.receiverAccessMode === "ask",
          requireKnownDevice: appPreferences.receiverAccessMode === "known-only",
        }));
      }
      return true;
    } catch (error) {
      if (!silent) {
        setCommandError(fmtError(error));
      }
      return false;
    } finally {
      setCommandPending(false);
    }
  }

  async function refreshBonjourStatus() {
    const [status, runtime] = await Promise.all([
      invoke<BonjourStatusSnapshot>("get_bonjour_status"),
      invoke<ReceiverRuntimeSnapshot>("refresh_receiver_readiness"),
    ]);

    setBonjourStatus(status);
    setReceiverRuntime(runtime);
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
    if (!approvalActionSupported) {
      setCommandError("This receiver build cannot confirm AirPlay trust from MirrorSim yet.");
      return;
    }

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
    if (!approvalActionSupported) {
      setPairing((previous) => ({ ...previous, phase: "idle", failureMessage: null, prompt: null, canTrust: false, displayPin: null }));
      return;
    }

    setCommandPending(true);

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

  async function installAvailableUpdate() {
    if (!availableUpdate || updateState === "installing") {
      return;
    }

    if (import.meta.env.DEV && devUpdatePreview) {
      setUpdateError("Updater install is disabled in local preview mode. Publish a GitHub Release with latest.json to test the real flow.");
      return;
    }

    setUpdateState("installing");
    setUpdateError(null);

    try {
      await invoke<AppUpdateInfo | null>("install_app_update");
    } catch (error) {
      setUpdateState("available");
      setUpdateError(fmtError(error));
    }
  }

  async function startSessionFlow(command: "start_session" | "reconnect_session", source: "manual" | "auto") {
    shouldMaintainConnectionRef.current = true;
    if (source === "manual") {
      setReconnectUiState(null);
      clearAutoReconnectTimer();
      reconnectAttemptRef.current = 0;
    }
    const ok = await runSessionCommand(command, source === "auto");
    if (!ok) {
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
    reconnectAttemptRef.current = 0;
    autoReconnectInFlightRef.current = false;
    setReconnectUiState(null);
    clearAutoReconnectTimer();
    await runSessionCommand("stop_session");
  }

  function openScreenshotSettings() {
    setSettingsOpen((value) => !value);
  }

  function doPrimary() {
    if (ss === "idle") void startSessionFlow("start_session", "manual");
    else if (isRec) void doRecordToggle();
    else void stopSessionFlow();
  }

  const bonjourToneClass =
    bonjourStatus.status === "missing"
      ? "border-amber-400/20 bg-amber-500/10 text-amber-100"
      : bonjourStatus.status === "stopped"
        ? "border-orange-400/20 bg-orange-500/10 text-orange-100"
        : "border-white/7 bg-[#15161a] text-white/75";

  useEffect(() => {
    if (!appPreferences.autoReconnectOnDrop || !shouldMaintainConnectionRef.current || isRec) {
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
    const delayMs = Math.min(8000, 1000 * 2 ** Math.min(attempt - 1, 3));
    const nextRetryAt = Date.now() + delayMs;

    setCommandError(`Connection dropped. Reconnecting${attempt > 1 ? ` (attempt ${attempt})` : ""} in ${Math.round(delayMs / 1000)}s.`);
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
  }, [appPreferences.autoReconnectOnDrop, commandPending, isRec, receiverRuntime.lastError, ss]);

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
      : `Update ${availableUpdate.version} is ready`
    : null;
  const updateDetail = availableUpdate?.notes?.split(/\r?\n/).map((line) => line.trim()).find(Boolean)
    ?? (availableUpdate
      ? import.meta.env.DEV && devUpdatePreview
        ? `This is a local updater UI preview. Publish a GitHub Release before testing a real install.`
        : `You're on ${availableUpdate.currentVersion}. Install the latest MirrorSim release from GitHub Releases.`
      : null);
  const updatePublishedLabel = availableUpdate?.pubDate
    ? new Date(availableUpdate.pubDate).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })
    : null;

  function renderUpdateBanner() {
    if (!availableUpdate) {
      return null;
    }

    return (
      <div className="rounded-[8px] border border-amber-400/20 bg-amber-500/10 p-2.5 text-amber-100">
        <div className="min-w-0">
          <div className="text-[11px] font-medium text-amber-100">{updateHeadline}</div>
          <p className="mt-1 text-[11px] leading-4 text-amber-100/80">{updateDetail}</p>
          {updatePublishedLabel && (
            <div className="mt-1 text-[10px] text-amber-100/65">Published {updatePublishedLabel}</div>
          )}
          {updateError && (
            <div className="mt-1 text-[10px] text-amber-100/80">{updateError}</div>
          )}
        </div>
        <div className="mt-2 grid grid-cols-2 gap-1.5">
          <button
            type="button"
            className="inline-flex min-w-0 items-center justify-center rounded-[5px] border border-white/10 bg-black/20 px-2.5 py-1 text-[11px] font-medium text-inherit transition hover:border-white/20 disabled:cursor-default disabled:opacity-40"
            onClick={() => void installAvailableUpdate()}
            disabled={updateState === "installing" || Boolean(import.meta.env.DEV && devUpdatePreview)}
          >
            {import.meta.env.DEV && devUpdatePreview
              ? "Preview only"
              : updateState === "installing"
                ? "Installing..."
                : "Install update"}
          </button>
          <button
            type="button"
            className="inline-flex min-w-0 items-center justify-center rounded-[5px] border border-white/10 bg-black/20 px-2.5 py-1 text-[11px] font-medium text-inherit transition hover:border-white/20"
            onClick={() => void openUrl(releasePageUrl).catch((error) => setCommandError(fmtError(error)))}
          >
            View release
          </button>
        </div>
      </div>
    );
  }

  function renderSettingsModal(embedded = false) {
    return (
    <SettingsModal
      open={settingsOpen}
      embedded={embedded}
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
      onInstallBonjour={() => void openUrl("https://support.apple.com/kb/DL999").catch((error) => setCommandError(fmtError(error)))}
      onRefreshBonjourStatus={() => void refreshBonjourStatus().catch((error) => setCommandError(fmtError(error)))}
      onOpenWindowsServices={() => void invoke("open_windows_services").catch((error) => setCommandError(fmtError(error)))}
      onOpenWindowsFirewall={() => void invoke("open_windows_firewall").catch((error) => setCommandError(fmtError(error)))}
      onExportDiagnostics={() => void exportDiagnostics()}
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
    ["Frames", String(preview.frameNumber)],
    ["Buffer", `+${bufferedAhead.toFixed(2)}s`],
    ["Queued", String(previewDiag.queuedSegments)],
    ["Init", previewDiag.initSegmentReady ? "ready" : "waiting"],
    ["Appended", String(previewClientDiag.mediaAppendCount)],
    ["Errors", String(previewClientDiag.appendErrorCount)],
    ["Bonjour", bonjourStatus.status],
    ["Transport", receiverRuntime.transport],
    ["Last error", receiverRuntime.lastError ?? surfaceError ?? commandError ?? "—"],
  ];

  const consoleDeviceFrame = (
    <DeviceFrame
      appMode={appMode}
      deviceFrameWidth={deviceFrameWidth}
      deviceWidthClass={deviceWidthClass}
      orientation={orientation}
      screenFrameClass={screenFrameClass}
      screenshotFlashActive={screenshotFlashActive}
      sessionState={ss}
      isLive={isLive}
      isIdle={isIdle}
      isRec={isRec}
      recElapsed={recElapsed}
      bonjourNeedsAttention={bonjourNeedsAttention}
      sessionHeadline={sessionHeadline}
      sessionSupportingText={sessionSupportingText}
      primarySessionActionLabel={primarySessionActionLabel}
      primarySessionActionDisabled={primarySessionActionDisabled}
      onPrimary={doPrimary}
      previewDimClass={previewDimClass}
      previewVideoStyle={previewVideoStyle}
      tone={tone}
      overlay={renderPairingModal(true)}
      setVideoEl={setVideoEl}
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
      sessionState={ss}
      isLive={isLive}
      isIdle={isIdle}
      isRec={isRec}
      recElapsed={recElapsed}
      bonjourNeedsAttention={bonjourNeedsAttention}
      sessionHeadline={sessionHeadline}
      sessionSupportingText={sessionSupportingText}
      primarySessionActionLabel={primarySessionActionLabel}
      primarySessionActionDisabled={primarySessionActionDisabled}
      onPrimary={doPrimary}
      previewDimClass={previewDimClass}
      previewVideoStyle={previewVideoStyle}
      tone={tone}
      overlay={settingsOpen ? renderSettingsModal(true) : renderPairingModal(true)}
      setVideoEl={setVideoEl}
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
          sideButtonClass={sideButtonClass}
          bonjourToneClass={bonjourToneClass}
          bonjourStatus={bonjourStatus}
          bonjourNeedsAttention={bonjourNeedsAttention}
          captures={captures}
          canCapture={canCapture}
          canRecord={canRecord}
          commandPending={commandPending}
          commandError={commandError}
          currentDeviceTrusted={session.currentDeviceTrusted}
          currentDeviceVisible={session.currentDeviceKey !== null}
          deviceFrame={consoleDeviceFrame}
          diagExpanded={diagExpanded}
          diagnosticsItems={diagnosticsItems}
          idleTelemetryHint={idleTelemetryHint}
          isConnected={isConnected}
          isIdle={isIdle}
          isLive={isLive}
          isRec={isRec}
          isTransitioningSession={isTransitioningSession}
          onAdjustZoom={adjustZoom}
          onCapture={() => void doCapture()}
          onGoMinimal={() => void goMinimal()}
          onInstallBonjour={() => void openUrl("https://support.apple.com/kb/DL999").catch((error) => setCommandError(fmtError(error)))}
          onOpenSettings={openScreenshotSettings}
          onOpenWindowsServices={() => void invoke("open_windows_services").catch((error) => setCommandError(fmtError(error)))}
          onPrimary={doPrimary}
          onRecordToggle={() => void doRecordToggle()}
          onRefreshBonjourStatus={() => void refreshBonjourStatus().catch((error) => setCommandError(fmtError(error)))}
          onRevealCapture={(capture) => void revealCaptureInExplorer(capture).catch((error) => setCommandError(fmtError(error)))}
          onRetryConnection={() => void startSessionFlow("reconnect_session", "manual")}
          onRotate={() => setOrientation((value) => (value === "portrait" ? "landscape" : "portrait"))}
          onStartWindowDrag={startWindowDrag}
          onTrustCurrentDevice={() => void trustCurrentDevice()}
          onToggleDiagnostics={() => setDiagExpanded((value) => !value)}
          onToggleFullscreen={() => void getCurrentWindow().toggleMaximize()}
          orientation={orientation}
          previewFps={preview.fps}
          previewLatencyMs={preview.latencyMs}
          previewBitrateKbps={preview.bitrateKbps}
          previewPresetLabel={previewPreset.label}
          primarySessionActionDisabled={primarySessionActionDisabled}
          primarySessionActionLabel={primarySessionActionLabel}
          primarySessionActionTitle={primarySessionActionTitle}
          recElapsed={recElapsed}
          reconnectBadge={renderReconnectBadge()}
          sessionHeadline={sessionHeadline}
          sessionSecondaryLabel={sessionSecondaryLabel}
          sessionSupportingText={sessionSupportingText}
          settingsOpen={settingsOpen}
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
        commandPending={commandPending}
        contextMenu={(
          <MinimalContextMenu
            canCapture={canCapture}
            canRecord={canRecord}
            contextMenu={contextMenu}
            isRec={isRec}
            latestSavedCapture={latestSavedCapture}
            onCapture={() => void doCapture()}
            onClose={() => setContextMenu(null)}
            onCopyToClipboard={() => void doCapture({ copyToClipboard: true, saveToDisk: false })}
            onGoConsole={() => void goConsole()}
            onOpenInExplorer={() => void revealCaptureInExplorer(latestSavedCapture).catch((error) => setCommandError(fmtError(error)))}
            onOpenSettings={openScreenshotSettings}
            onRecordToggle={() => void doRecordToggle()}
            onSaveToDocuments={() => void doCapture({ saveToDisk: true, copyToClipboard: false, saveLocation: "documents" })}
            onZoomIn={() => adjustZoom(1)}
            onZoomOut={() => adjustZoom(-1)}
            onZoomReset={() => setZoom(1)}
            zoomCanIncrease={ZOOM_LEVELS.indexOf(zoom) !== ZOOM_LEVELS.length - 1}
            zoomCanDecrease={ZOOM_LEVELS.indexOf(zoom) !== 0}
          />
        )}
        deviceFrame={minimalDeviceFrame}
        isRec={isRec}
        minimalFloatingButtonClass={minimalFloatingButtonClass}
        minimalShellRef={minimalShellRef}
        onCapture={() => void doCapture()}
        onFit={() => {
          console.log("[MirrorSim] fit button clicked", {
            orientation,
            shellPresent: Boolean(minimalShellRef.current),
          });
          void fitMinimalWindow(orientation);
        }}
        onGoConsole={() => void goConsole()}
        onOpenSettings={openScreenshotSettings}
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
        settingsOpen={settingsOpen}
        settingsModal={null}
        showConsoleBadge={shouldShowUpdateBadge}
        shellWidth={MINIMAL_SHELL_WIDTH[orientation]}
        titlebarStateDotClass={cn("h-1.5 w-1.5 rounded-full", titlebarStateDotClass)}
        titlebarStateLabel={titlebarStateLabel}
      />
    </>
  );
}
