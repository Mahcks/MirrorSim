import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { LogicalSize } from "@tauri-apps/api/dpi";
import { open } from "@tauri-apps/plugin-dialog";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { cn } from "@/lib/utils";
import {
  attachMockPreviewStream,
  initialPreviewStreamClientDiagnostics,
  type MockPreviewStreamStatus,
  type PreviewStreamClientDiagnostics,
} from "./mockPreviewStream";
import {
  initialPreviewDiagnostics,
  initialReceiverRuntime,
  PREVIEW_DIAGNOSTICS_EVENT,
  PREVIEW_STREAM_EVENT,
  RECEIVER_RUNTIME_EVENT,
  type PreviewDiagnosticsSnapshot,
  type PreviewStreamDescriptor,
  type ReceiverRuntimeSnapshot,
} from "./receiverContract";

// ── constants & types ────────────────────────────────────────────────────────

const ZOOM_LEVELS = [0.5, 0.75, 1, 1.5, 2] as const;
type ZoomLevel = (typeof ZOOM_LEVELS)[number];
const PREFERENCES_STORAGE_KEY = "mirrorsim.preferences.v1";
const LEGACY_SCREENSHOT_SETTINGS_STORAGE_KEY = "mirrorsim.screenshot-settings.v1";

const SESSION_STATUS_EVENT = "session-status";
const PREVIEW_TELEMETRY_EVENT = "preview-telemetry";

type AppMode = "console" | "minimal";
type Orientation = "portrait" | "landscape";
type SessionState = "idle" | "discovering" | "connecting" | "mirroring" | "recording";
type SessionCommand =
  | "get_session_snapshot"
  | "get_preview_telemetry"
  | "get_preview_stream_descriptor"
  | "get_preview_init_segment"
  | "take_preview_media_segment"
  | "get_preview_diagnostics"
  | "get_receiver_runtime"
  | "start_session"
  | "reconnect_session"
  | "stop_session"
  | "take_screenshot"
  | "start_recording"
  | "stop_recording";

type SessionSnapshot = { status: SessionState; captureCount: number; deviceName: string };
type PreviewTelemetry = {
  frameNumber: number;
  fps: number;
  bitrateKbps: number;
  latencyMs: number;
  activity: number;
};
type VideoElementDiag = {
  currentTime: number;
  bufferedEnd: number;
  readyState: number;
  paused: boolean;
  totalVideoFrames: number;
  droppedVideoFrames: number;
};
type Capture = {
  id: string;
  type: "screenshot" | "recording";
  name: string;
  duration?: number;
  addedAt: number;
  filePath?: string;
};
type ContextMenuPos = { x: number; y: number };
type ScreenshotSaveLocation = "pictures" | "documents" | "downloads" | "custom";
type ScreenshotSettings = {
  saveToDisk: boolean;
  copyToClipboard: boolean;
  saveLocation: ScreenshotSaveLocation;
  customSavePath: string;
  fileNamePrefix: string;
  includeTimestamp: boolean;
};
type RecordingSettings = {
  saveLocation: ScreenshotSaveLocation;
  customSavePath: string;
  fileNamePrefix: string;
  includeTimestamp: boolean;
  autoReveal: boolean;
};
type AppPreferences = {
  launchMode: AppMode;
  rememberLastMode: boolean;
  rememberLastOrientation: boolean;
  keepMinimalOnTop: boolean;
  autoRevealSavedCaptures: boolean;
  screenshotFlashEnabled: boolean;
  autoStartDiscovery: boolean;
  autoReconnectOnDrop: boolean;
  openDiagnosticsOnError: boolean;
  lastMode: AppMode;
  lastOrientation: Orientation;
};
type StoredPreferences = {
  screenshots?: Partial<ScreenshotSettings>;
  recordings?: Partial<RecordingSettings>;
  app?: Partial<AppPreferences>;
};
type ScreenshotCaptureOverrides = Partial<
  Pick<ScreenshotSettings, "saveToDisk" | "copyToClipboard" | "saveLocation" | "customSavePath">
>;
type SavedCaptureFile = {
  fileName: string;
  filePath: string;
};
type IconName =
  | "phone"
  | "camera"
  | "record"
  | "fullscreen"
  | "zoom-in"
  | "zoom-out"
  | "rotate"
  | "settings"
  | "reconnect"
  | "chevron-right"
  | "chevron-down"
  | "compress"
  | "console";

const MINIMAL_TITLEBAR_HEIGHT = 44;
const MINIMAL_SHELL_WIDTH: Record<Orientation, number> = {
  portrait: 393,
  landscape: 736,
};
const MINIMAL_WINDOW_SIZE: Record<Orientation, { width: number; height: number }> = {
  portrait: { width: MINIMAL_SHELL_WIDTH.portrait, height: 805 + MINIMAL_TITLEBAR_HEIGHT },
  landscape: { width: MINIMAL_SHELL_WIDTH.landscape, height: 361 + MINIMAL_TITLEBAR_HEIGHT },
};

const DEVICE_RENDER_WIDTH: Record<Orientation, number> = {
  portrait: 393,
  landscape: 736,
};

const defaultScreenshotSettings: ScreenshotSettings = {
  saveToDisk: true,
  copyToClipboard: false,
  saveLocation: "pictures",
  customSavePath: "",
  fileNamePrefix: "mirrorsim_screenshot",
  includeTimestamp: true,
};

const defaultRecordingSettings: RecordingSettings = {
  saveLocation: "pictures",
  customSavePath: "",
  fileNamePrefix: "mirrorsim_recording",
  includeTimestamp: true,
  autoReveal: false,
};

const defaultAppPreferences: AppPreferences = {
  launchMode: "console",
  rememberLastMode: true,
  rememberLastOrientation: true,
  keepMinimalOnTop: false,
  autoRevealSavedCaptures: false,
  screenshotFlashEnabled: true,
  autoStartDiscovery: false,
  autoReconnectOnDrop: true,
  openDiagnosticsOnError: true,
  lastMode: "console",
  lastOrientation: "portrait",
};

// ── helpers ──────────────────────────────────────────────────────────────────

const fmtError = (e: unknown) => (e instanceof Error ? e.message : String(e));

function readBufferedEnd(v: HTMLVideoElement) {
  try {
    return v.buffered.length === 0 ? 0 : v.buffered.end(v.buffered.length - 1);
  } catch {
    return 0;
  }
}

function fmtDuration(s: number): string {
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  return h > 0
    ? `${h}:${String(m).padStart(2, "0")}:${String(ss).padStart(2, "0")}`
    : `${String(m).padStart(2, "0")}:${String(ss).padStart(2, "0")}`;
}

function fmtFilenameDate(d: Date): string {
  return (
    `${d.getFullYear()}` +
    `${String(d.getMonth() + 1).padStart(2, "0")}` +
    `${String(d.getDate()).padStart(2, "0")}_` +
    `${String(d.getHours()).padStart(2, "0")}` +
    `${String(d.getMinutes()).padStart(2, "0")}` +
    `${String(d.getSeconds()).padStart(2, "0")}`
  );
}

function sanitizeFilenamePart(value: string): string {
  const sanitized = value.trim().replace(/[<>:"/\\|?*\x00-\x1F]/g, "-").replace(/\s+/g, "_");
  return sanitized || "mirrorsim_screenshot";
}

function buildScreenshotFileName(settings: ScreenshotSettings, now: Date): string {
  const prefix = sanitizeFilenamePart(settings.fileNamePrefix);
  return settings.includeTimestamp ? `${prefix}_${fmtFilenameDate(now)}.png` : `${prefix}.png`;
}

function buildRecordingFileName(settings: RecordingSettings, now: Date): string {
  const prefix = sanitizeFilenamePart(settings.fileNamePrefix);
  return settings.includeTimestamp ? `${prefix}_${fmtFilenameDate(now)}.webm` : `${prefix}.webm`;
}

function uint8ArrayToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;

  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }

  return btoa(binary);
}

function mergeStoredPreferences(stored: StoredPreferences | null) {
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

// ── Icon ─────────────────────────────────────────────────────────────────────

function Icon({ name, size = 16 }: { name: IconName; size?: number }) {
  const p = {
    viewBox: "0 0 24 24",
    width: size,
    height: size,
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.75,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    "aria-hidden": true as true,
  };
  switch (name) {
    case "phone":
      return (
        <svg {...p}>
          <rect x="6" y="2" width="12" height="20" rx="2.5" />
          <path d="M10 17.5h4" />
        </svg>
      );
    case "camera":
      return (
        <svg {...p}>
          <path d="M4 9h3l1.4-2h7.2l1.4 2H20v10H4z" />
          <circle cx="12" cy="14" r="3" />
        </svg>
      );
    case "record":
      return (
        <svg {...p}>
          <rect x="4" y="5" width="16" height="14" rx="3" />
          <circle cx="12" cy="12" r="3.5" />
        </svg>
      );
    case "fullscreen":
      return (
        <svg {...p}>
          <path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" />
        </svg>
      );
    case "zoom-in":
      return (
        <svg {...p}>
          <circle cx="10.5" cy="10.5" r="6.5" />
          <path d="m21 21-4.5-4.5M10.5 7.5v6M7.5 10.5h6" />
        </svg>
      );
    case "zoom-out":
      return (
        <svg {...p}>
          <circle cx="10.5" cy="10.5" r="6.5" />
          <path d="m21 21-4.5-4.5M7.5 10.5h6" />
        </svg>
      );
    case "rotate":
      return (
        <svg {...p}>
          <path d="M16.5 7H20V3.5" />
          <path d="M19.5 7.5A8 8 0 1 0 20 12" />
        </svg>
      );
    case "settings":
      return (
        <svg {...p}>
          <circle cx="12" cy="12" r="3" />
          <path d="M12 2v2m0 16v2M4.22 4.22l1.42 1.42m12.72 12.72 1.42 1.42M2 12h2m16 0h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42" />
        </svg>
      );
    case "reconnect":
      return (
        <svg {...p}>
          <path d="M2.5 4v5h5" />
          <path d="M2.5 9A9.5 9.5 0 0 1 12 2.5a9.5 9.5 0 0 1 9.5 9.5A9.5 9.5 0 0 1 12 21.5a9.5 9.5 0 0 1-6.5-2.5" />
        </svg>
      );
    case "chevron-right":
      return (
        <svg {...p}>
          <path d="m9 18 6-6-6-6" />
        </svg>
      );
    case "chevron-down":
      return (
        <svg {...p}>
          <path d="m6 9 6 6 6-6" />
        </svg>
      );
    case "compress":
      return (
        <svg {...p}>
          <path d="M14 10 21 3M21 3h-6M21 3v6M10 14 3 21M3 21h6M3 21v-6" />
        </svg>
      );
    case "console":
      return (
        <svg {...p}>
          <rect x="3" y="5" width="18" height="14" rx="3" />
          <path d="M7.5 10.5 10 13l-2.5 2.5M12.5 15.5h4" />
        </svg>
      );
  }
}

// ── TrafficLights ─────────────────────────────────────────────────────────────

function TrafficLights() {
  const win = getCurrentWindow();
  return (
    <div className="flex shrink-0 items-center gap-2">
      <button
        className="h-3 w-3 rounded-full bg-[#ff5f57] transition hover:brightness-110"
        aria-label="Close"
        onClick={() => void win.close()}
      />
      <button
        className="h-3 w-3 rounded-full bg-[#ffbd2e] transition hover:brightness-110"
        aria-label="Minimize"
        onClick={() => void win.minimize()}
      />
      <button
        className="h-3 w-3 rounded-full bg-[#28c840] transition hover:brightness-110"
        aria-label="Maximize"
        onClick={() => void win.toggleMaximize()}
      />
    </div>
  );
}

async function startWindowDrag(event: React.MouseEvent<HTMLElement>) {
  if (event.button !== 0) {
    return;
  }

  const window = getCurrentWindow();

  if (event.detail === 2) {
    await window.toggleMaximize();
    return;
  }

  await window.startDragging();
}

// ── App ───────────────────────────────────────────────────────────────────────

export default function App() {
  const [appMode, setAppMode] = useState<AppMode>("console");
  const [orientation, setOrientation] = useState<Orientation>("portrait");
  const [zoom, setZoom] = useState<ZoomLevel>(1);
  const [session, setSession] = useState<SessionSnapshot>({
    status: "idle",
    captureCount: 0,
    deviceName: "iPhone 15 Pro",
  });
  const [preview, setPreview] = useState<PreviewTelemetry>({
    frameNumber: 0,
    fps: 0,
    bitrateKbps: 0,
    latencyMs: 0,
    activity: 0,
  });
  const [previewStream, setPreviewStream] = useState<PreviewStreamDescriptor | null>(null);
  const [receiverRuntime, setReceiverRuntime] = useState<ReceiverRuntimeSnapshot>(initialReceiverRuntime);
  const [previewDiag, setPreviewDiag] = useState<PreviewDiagnosticsSnapshot>(initialPreviewDiagnostics);
  const [previewClientDiag, setPreviewClientDiag] = useState<PreviewStreamClientDiagnostics>(
    initialPreviewStreamClientDiagnostics,
  );
  const [videoDiag, setVideoDiag] = useState<VideoElementDiag>({
    currentTime: 0,
    bufferedEnd: 0,
    readyState: 0,
    paused: true,
    totalVideoFrames: 0,
    droppedVideoFrames: 0,
  });
  const [surfaceStatus, setSurfaceStatus] = useState<MockPreviewStreamStatus>("loading");
  const [surfaceError, setSurfaceError] = useState<string | null>(null);
  const [commandPending, setCommandPending] = useState(false);
  const [commandError, setCommandError] = useState<string | null>(null);
  const [diagExpanded, setDiagExpanded] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [contextMenu, setContextMenu] = useState<ContextMenuPos | null>(null);
  const [captures, setCaptures] = useState<Capture[]>([]);
  const [screenshotSettings, setScreenshotSettings] = useState<ScreenshotSettings>(defaultScreenshotSettings);
  const [recordingSettings, setRecordingSettings] = useState<RecordingSettings>(defaultRecordingSettings);
  const [appPreferences, setAppPreferences] = useState<AppPreferences>(defaultAppPreferences);
  const [screenshotFlashActive, setScreenshotFlashActive] = useState(false);
  const [recElapsed, setRecElapsed] = useState(0);
  const [videoEl, setVideoEl] = useState<HTMLVideoElement | null>(null);
  const [reconnectUiState, setReconnectUiState] = useState<{ attempt: number; phase: "scheduled" | "retrying" } | null>(null);
  const [reconnectNextRetryAt, setReconnectNextRetryAt] = useState<number | null>(null);
  const recStartRef = useRef<number | null>(null);
  const recordingStreamRef = useRef<MediaStream | null>(null);
  const recordingChunksRef = useRef<Blob[]>([]);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const shouldMaintainConnectionRef = useRef(false);
  const reconnectAttemptRef = useRef(0);
  const reconnectTimerRef = useRef<number | null>(null);
  const autoReconnectInFlightRef = useRef(false);
  const startupPreferencesAppliedRef = useRef(false);
  const autoDiscoveryAttemptedRef = useRef(false);
  const minimalShellRef = useRef<HTMLDivElement | null>(null);

  // derived
  const ss = session.status;
  const isConnected = ss !== "idle";
  const isLive = ss === "mirroring" || ss === "recording";
  const isRec = ss === "recording";
  const canCapture = isLive;
  const canRecord = isLive;
  const tone: "inactive" | "live" | "warning" =
    surfaceStatus === "error" || surfaceStatus === "unsupported"
      ? "warning"
      : isLive && surfaceStatus === "ready"
        ? "live"
        : "inactive";
  const bufferedAhead = Math.max(0, videoDiag.bufferedEnd - videoDiag.currentTime);
  const reconnectCountdownSeconds = reconnectNextRetryAt === null ? null : Math.max(0, Math.ceil((reconnectNextRetryAt - Date.now()) / 1000));
  const zoomIndex = ZOOM_LEVELS.indexOf(zoom);
  const controlButtonClass =
    "inline-flex h-8 w-8 items-center justify-center rounded-[5px] text-white/55 transition hover:bg-[#1a1b1e] hover:text-white disabled:cursor-default disabled:opacity-30";
  const sideButtonClass =
    "inline-flex h-9 w-9 items-center justify-center rounded-[8px] text-white/55 transition hover:bg-[#1a1b1e] hover:text-white disabled:cursor-default disabled:opacity-30";
  const minimalFloatingButtonClass =
    "inline-flex h-7 w-7 items-center justify-center rounded-lg text-white/65 transition hover:bg-white/8 hover:text-white disabled:cursor-default disabled:opacity-30";
  const panelSurfaceClass =
    "border-white/7 bg-[#131416]";
  const previewDimClass =
    tone === "warning" ? "opacity-[0.08]" : tone === "inactive" ? "opacity-45" : "opacity-100";
  const screenFrameClass = cn(
    "relative overflow-hidden bg-[#050506] shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]",
    orientation === "portrait" ? "aspect-[393/852] rounded-[46px]" : "aspect-[852/393] rounded-[34px]",
    isRec && "shadow-[0_0_0_1.5px_rgba(239,68,68,0.48),0_0_40px_rgba(239,68,68,0.10)]",
  );
  const deviceFrameWidth = DEVICE_RENDER_WIDTH[orientation];
  const deviceWidthClass = orientation === "portrait" ? "rounded-[52px]" : "rounded-[40px]";

  function renderStatusBadge(content: string, live = false) {
    return (
      <span
        className={cn(
          "inline-flex items-center gap-1 whitespace-nowrap rounded-full border px-2 py-0.5 text-[11px] font-medium tracking-[-0.01em]",
          live
            ? "border-red-500/25 bg-red-500/15 text-red-300"
            : "border-white/7 bg-[#1a1b1e] text-white/55",
        )}
      >
        {content}
      </span>
    );
  }

  function renderReconnectBadge(compact = false) {
    if (!reconnectUiState) return null;

    const content =
      reconnectUiState.phase === "retrying"
        ? `Reconnecting${reconnectUiState.attempt > 1 ? ` #${reconnectUiState.attempt}` : ""}`
        : `Reconnect${reconnectCountdownSeconds !== null ? ` in ${reconnectCountdownSeconds}s` : " queued"}`;

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

  // recording timer
  useEffect(() => {
    if (!isRec) {
      recStartRef.current = null;
      setRecElapsed(0);
      return;
    }
    if (recStartRef.current === null) recStartRef.current = Date.now();
    const t0 = recStartRef.current;
    const id = window.setInterval(() => setRecElapsed(Math.floor((Date.now() - t0) / 1000)), 1000);
    return () => window.clearInterval(id);
  }, [isRec]);

  useEffect(() => {
    try {
      const rawPreferences = localStorage.getItem(PREFERENCES_STORAGE_KEY);
      if (rawPreferences) {
        const parsed = JSON.parse(rawPreferences) as StoredPreferences;
        const merged = mergeStoredPreferences(parsed);
        setScreenshotSettings(merged.screenshots);
        setRecordingSettings(merged.recordings);
        setAppPreferences(merged.app);
        return;
      }

      const legacyScreenshotSettings = localStorage.getItem(LEGACY_SCREENSHOT_SETTINGS_STORAGE_KEY);
      if (!legacyScreenshotSettings) return;

      const parsed = JSON.parse(legacyScreenshotSettings) as Partial<ScreenshotSettings>;
      setScreenshotSettings({
        ...defaultScreenshotSettings,
        ...parsed,
      });
    } catch {
      localStorage.removeItem(PREFERENCES_STORAGE_KEY);
      localStorage.removeItem(LEGACY_SCREENSHOT_SETTINGS_STORAGE_KEY);
    }
  }, []);

  useEffect(() => {
    localStorage.setItem(
      PREFERENCES_STORAGE_KEY,
      JSON.stringify({
        screenshots: screenshotSettings,
        recordings: recordingSettings,
        app: appPreferences,
      } satisfies StoredPreferences),
    );
  }, [appPreferences, recordingSettings, screenshotSettings]);

  // Apply console-mode minimum size on startup (tauri.conf.json has no minWidth/minHeight)
  useEffect(() => {
    void getCurrentWindow().setMinSize(new LogicalSize(700, 580)).catch(() => {});
  }, []);

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
    if (startupPreferencesAppliedRef.current) return;
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
  }, [appPreferences, orientation]);

  useEffect(() => {
    const win = getCurrentWindow();

    void (async () => {
      try {
        await win.setShadow(appMode === "console");
        await win.setAlwaysOnTop(appMode === "minimal" && appPreferences.keepMinimalOnTop);
      } catch {
        // not critical
      }
    })();
  }, [appMode, appPreferences.keepMinimalOnTop]);

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
  useEffect(() => {
    let alive = true;
    const unsubs: Array<() => void> = [];

    void (async () => {
      try {
        unsubs.push(
          await listen<SessionSnapshot>(SESSION_STATUS_EVENT, (e) => {
            if (alive) {
              setSession(e.payload);
              setCommandError(null);
            }
          }),
        );
        unsubs.push(
          await listen<PreviewTelemetry>(PREVIEW_TELEMETRY_EVENT, (e) => {
            if (alive) setPreview(e.payload);
          }),
        );
        unsubs.push(
          await listen<PreviewStreamDescriptor>(PREVIEW_STREAM_EVENT, (e) => {
            if (alive) setPreviewStream(e.payload);
          }),
        );
        unsubs.push(
          await listen<PreviewDiagnosticsSnapshot>(PREVIEW_DIAGNOSTICS_EVENT, (e) => {
            if (alive) setPreviewDiag(e.payload);
          }),
        );
        unsubs.push(
          await listen<ReceiverRuntimeSnapshot>(RECEIVER_RUNTIME_EVENT, (e) => {
            if (alive) setReceiverRuntime(e.payload);
          }),
        );

        const [snap, tel, runtime, diag, stream] = await Promise.all([
          invoke<SessionSnapshot>("get_session_snapshot"),
          invoke<PreviewTelemetry>("get_preview_telemetry"),
          invoke<ReceiverRuntimeSnapshot>("get_receiver_runtime"),
          invoke<PreviewDiagnosticsSnapshot>("get_preview_diagnostics"),
          invoke<PreviewStreamDescriptor>("get_preview_stream_descriptor"),
        ]);

        if (alive) {
          setSession(snap);
          setPreview(tel);
          setReceiverRuntime(runtime);
          setPreviewDiag(diag);
          setPreviewStream(stream);
        }
      } catch (e) {
        if (alive) setCommandError(fmtError(e));
      }
    })();

    return () => {
      alive = false;
      unsubs.forEach((f) => f());
    };
  }, []);

  // reset client diagnostics when stream changes
  useEffect(() => {
    setPreviewClientDiag(initialPreviewStreamClientDiagnostics);
    setVideoDiag({
      currentTime: 0,
      bufferedEnd: 0,
      readyState: 0,
      paused: true,
      totalVideoFrames: 0,
      droppedVideoFrames: 0,
    });
  }, [previewStream?.streamId]);

  // attach stream — re-runs when video element changes (on mode switch)
  useEffect(() => {
    if (!videoEl || !previewStream) return;
    return attachMockPreviewStream(videoEl, previewStream, {
      onStatusChange: (s) => {
        setSurfaceStatus(s);
        if (s !== "error") setSurfaceError(null);
      },
      onError: (msg) => setSurfaceError(msg),
      onDiagnosticsChange: (d) => setPreviewClientDiag(d),
    });
  }, [previewStream, videoEl]);

  // sync video diagnostics
  useEffect(() => {
    if (!videoEl) return;
    const sync = () => {
      const q =
        typeof videoEl.getVideoPlaybackQuality === "function"
          ? videoEl.getVideoPlaybackQuality()
          : null;
      setVideoDiag({
        currentTime: videoEl.currentTime,
        bufferedEnd: readBufferedEnd(videoEl),
        readyState: videoEl.readyState,
        paused: videoEl.paused,
        totalVideoFrames: q?.totalVideoFrames ?? 0,
        droppedVideoFrames: q?.droppedVideoFrames ?? 0,
      });
    };
    sync();
    const id = window.setInterval(sync, 250);
    return () => window.clearInterval(id);
  }, [previewStream?.streamId, surfaceStatus, videoEl]);

  // play / pause based on session state
  useEffect(() => {
    if (!videoEl || surfaceStatus !== "ready") return;
    if (isLive) {
      void videoEl.play().catch((e) => {
        setSurfaceError(fmtError(e));
        setSurfaceStatus("error");
      });
      return;
    }
    videoEl.pause();
    videoEl.currentTime = 0;
  }, [isLive, surfaceStatus, videoEl]);

  // catch-up to live edge if stalled
  useEffect(() => {
    if (!videoEl || !isLive || surfaceStatus !== "ready") return;
    const lead = videoDiag.bufferedEnd - videoDiag.currentTime;
    if (!(!videoDiag.paused && lead > 0.75 && videoDiag.readyState >= 2)) return;
    const edge = Math.max(0, videoDiag.bufferedEnd - 0.12);
    if (edge <= videoDiag.currentTime + 0.2) return;
    videoEl.currentTime = edge;
    void videoEl.play().catch((e) => {
      setSurfaceError(fmtError(e));
      setSurfaceStatus("error");
    });
  }, [isLive, surfaceStatus, videoDiag, videoEl]);

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

  async function runCmd(command: SessionCommand): Promise<boolean> {
    setCommandPending(true);
    setCommandError(null);
    try {
      setSession(await invoke<SessionSnapshot>(command));
      return true;
    } catch (e) {
      setCommandError(fmtError(e));
      return false;
    } finally {
      setCommandPending(false);
    }
  }

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
      setSession(await invoke<SessionSnapshot>(command));
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

  async function startSessionFlow(command: "start_session" | "reconnect_session", source: "manual" | "auto") {
    shouldMaintainConnectionRef.current = true;
    if (source === "manual") {
      setReconnectUiState(null);
      clearAutoReconnectTimer();
      reconnectAttemptRef.current = 0;
    }
    const ok = await runSessionCommand(command, source === "auto");
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

  function setScreenshotSetting<K extends keyof ScreenshotSettings>(key: K, value: ScreenshotSettings[K]) {
    setScreenshotSettings((previous) => ({
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

  function setRecordingSetting<K extends keyof RecordingSettings>(key: K, value: RecordingSettings[K]) {
    setRecordingSettings((previous) => ({
      ...previous,
      [key]: value,
    }));
  }

  async function captureVideoFrameBlob(): Promise<Blob> {
    if (!videoEl || videoEl.readyState < 2 || videoEl.videoWidth === 0 || videoEl.videoHeight === 0) {
      throw new Error("Live preview is not ready for screenshots yet.");
    }

    const canvas = document.createElement("canvas");
    canvas.width = videoEl.videoWidth;
    canvas.height = videoEl.videoHeight;

    const context = canvas.getContext("2d");
    if (!context) {
      throw new Error("Could not create screenshot canvas.");
    }

    context.drawImage(videoEl, 0, 0, canvas.width, canvas.height);

    const blob = await new Promise<Blob | null>((resolve) => {
      canvas.toBlob(resolve, "image/png");
    });

    if (!blob) {
      throw new Error("Could not encode screenshot image.");
    }

    return blob;
  }

  async function copyScreenshotToClipboard(blob: Blob) {
    const ClipboardItemCtor = window.ClipboardItem;
    if (!navigator.clipboard?.write || !ClipboardItemCtor) {
      throw new Error("Image clipboard is not available in this environment.");
    }

    await navigator.clipboard.write([
      new ClipboardItemCtor({
        [blob.type]: blob,
      }),
    ]);
  }

  async function saveScreenshotToDisk(
    blob: Blob,
    fileName: string,
    location: ScreenshotSaveLocation,
    customDirectory?: string,
  ) {
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const pngBase64 = uint8ArrayToBase64(bytes);

    return invoke<SavedCaptureFile>("save_screenshot", {
      request: {
        fileName,
        pngBase64,
        location,
        customDirectory: location === "custom" ? customDirectory ?? null : null,
      },
    });
  }

  async function saveRecordingToDisk(
    blob: Blob,
    fileName: string,
    location: ScreenshotSaveLocation,
    customDirectory?: string,
  ) {
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const mediaBase64 = uint8ArrayToBase64(bytes);

    return invoke<SavedCaptureFile>("save_recording", {
      request: {
        fileName,
        mediaBase64,
        location,
        customDirectory: location === "custom" ? customDirectory ?? null : null,
      },
    });
  }

  async function chooseScreenshotFolder() {
    const selection = await open({
      directory: true,
      multiple: false,
      defaultPath: screenshotSettings.customSavePath || undefined,
      title: "Choose Screenshot Folder",
    });

    if (typeof selection !== "string") {
      return;
    }

    setScreenshotSettings((previous) => ({
      ...previous,
      saveLocation: "custom",
      customSavePath: selection,
    }));
    setCommandError(null);
  }

  async function chooseRecordingFolder() {
    const selection = await open({
      directory: true,
      multiple: false,
      defaultPath: recordingSettings.customSavePath || undefined,
      title: "Choose Recording Folder",
    });

    if (typeof selection !== "string") {
      return;
    }

    setRecordingSettings((previous) => ({
      ...previous,
      saveLocation: "custom",
      customSavePath: selection,
    }));
    setCommandError(null);
  }

  function getRecordingMimeType() {
    const candidates = ["video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm"];

    for (const candidate of candidates) {
      if (typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(candidate)) {
        return candidate;
      }
    }

    return "";
  }

  async function startLocalRecording() {
    if (!videoEl || videoEl.readyState < 2 || videoEl.videoWidth === 0 || videoEl.videoHeight === 0) {
      throw new Error("Live preview is not ready for recording yet.");
    }

    if (typeof MediaRecorder === "undefined") {
      throw new Error("Recording is not available in this environment.");
    }

    const previewVideo = videoEl as HTMLVideoElement & { captureStream?: () => MediaStream };
    const previewCaptureStream = typeof previewVideo.captureStream === "function" ? previewVideo.captureStream() : null;
    if (!previewCaptureStream) {
      throw new Error("The preview surface cannot be captured for recording here.");
    }

    const mimeType = getRecordingMimeType();
    const mediaRecorder = mimeType
      ? new MediaRecorder(previewCaptureStream, { mimeType })
      : new MediaRecorder(previewCaptureStream);

    recordingChunksRef.current = [];
    mediaRecorder.addEventListener("dataavailable", (event) => {
      if (event.data.size > 0) {
        recordingChunksRef.current.push(event.data);
      }
    });

    mediaRecorder.start(1000);
    mediaRecorderRef.current = mediaRecorder;
    recordingStreamRef.current = previewCaptureStream;
  }

  async function stopLocalRecording() {
    const mediaRecorder = mediaRecorderRef.current;
    if (!mediaRecorder) {
      throw new Error("Recording was not started in the preview surface.");
    }

    const stoppedBlob = await new Promise<Blob>((resolve, reject) => {
      const handleStop = () => {
        cleanup();
        resolve(new Blob(recordingChunksRef.current, { type: mediaRecorder.mimeType || "video/webm" }));
      };
      const handleError = () => {
        cleanup();
        reject(new Error("The recording session failed to finalize."));
      };
      const cleanup = () => {
        mediaRecorder.removeEventListener("stop", handleStop);
        mediaRecorder.removeEventListener("error", handleError);
      };

      mediaRecorder.addEventListener("stop", handleStop, { once: true });
      mediaRecorder.addEventListener("error", handleError, { once: true });
      mediaRecorder.stop();
    });

    recordingStreamRef.current?.getTracks().forEach((track) => track.stop());
    recordingStreamRef.current = null;
    mediaRecorderRef.current = null;

    return stoppedBlob;
  }

  async function revealCaptureInExplorer(capture: Capture | undefined) {
    if (!capture?.filePath) {
      throw new Error("There is no saved screenshot to reveal yet.");
    }

    await revealItemInDir(capture.filePath);
  }

  async function doCapture(overrides: ScreenshotCaptureOverrides = {}) {
    if (!canCapture) return;

    const captureSettings: ScreenshotSettings = {
      ...screenshotSettings,
      ...overrides,
    };

    if (!captureSettings.saveToDisk && !captureSettings.copyToClipboard) {
      setCommandError("Enable disk save or clipboard copy in Screenshot Settings first.");
      return;
    }

    if (captureSettings.saveToDisk && captureSettings.saveLocation === "custom" && !captureSettings.customSavePath.trim()) {
      setCommandError("Enter a custom screenshot folder before using the custom save location.");
      return;
    }

    setCommandPending(true);
    setCommandError(null);

    try {
      const now = new Date();
      const fileName = buildScreenshotFileName(captureSettings, now);
      const screenshotBlob = await captureVideoFrameBlob();
      let savedScreenshot: SavedCaptureFile | null = null;

      if (captureSettings.saveToDisk) {
        savedScreenshot = await saveScreenshotToDisk(
          screenshotBlob,
          fileName,
          captureSettings.saveLocation,
          captureSettings.customSavePath,
        );
      }

      if (captureSettings.copyToClipboard) {
        await copyScreenshotToClipboard(screenshotBlob);
      }

      setSession(await invoke<SessionSnapshot>("take_screenshot"));
      if (appPreferences.screenshotFlashEnabled) {
        setScreenshotFlashActive(true);
      }

      if (savedScreenshot?.filePath && appPreferences.autoRevealSavedCaptures) {
        await revealItemInDir(savedScreenshot.filePath);
      }

      setCaptures((p) => [
        ...p,
        {
          id: crypto.randomUUID(),
          type: "screenshot",
          name: savedScreenshot?.fileName ?? fileName,
          addedAt: Date.now(),
          filePath: savedScreenshot?.filePath,
        },
      ]);
    } catch (e) {
      setCommandError(fmtError(e));
    } finally {
      setCommandPending(false);
    }
  }

  function openScreenshotSettings() {
    setSettingsOpen(true);
  }

  async function doRecordToggle() {
    if (!canRecord) return;
    setCommandPending(true);
    setCommandError(null);

    try {
      if (isRec) {
        const elapsed = recElapsed;
        const recordedBlob = await stopLocalRecording();
        const stopped = await runCmd("stop_recording");

        if (stopped) {
          const now = new Date();
          const fileName = buildRecordingFileName(recordingSettings, now);
          const savedRecording = await saveRecordingToDisk(
            recordedBlob,
            fileName,
            recordingSettings.saveLocation,
            recordingSettings.customSavePath,
          );

          if (recordingSettings.autoReveal || appPreferences.autoRevealSavedCaptures) {
            await revealItemInDir(savedRecording.filePath);
          }

          setCaptures((p) => [
            ...p,
            {
              id: crypto.randomUUID(),
              type: "recording",
              name: savedRecording.fileName,
              duration: elapsed,
              addedAt: Date.now(),
              filePath: savedRecording.filePath,
            },
          ]);
        }
      } else {
        if (recordingSettings.saveLocation === "custom" && !recordingSettings.customSavePath.trim()) {
          throw new Error("Choose a recording folder before saving to a custom location.");
        }

        await startLocalRecording();
        const started = await runCmd("start_recording");

        if (!started) {
          throw new Error("MirrorSim could not start recording.");
        }
      }
    } catch (error) {
      if (!isRec && mediaRecorderRef.current) {
        mediaRecorderRef.current.stop();
      }
      recordingStreamRef.current?.getTracks().forEach((track) => track.stop());
      recordingStreamRef.current = null;
      mediaRecorderRef.current = null;
      recordingChunksRef.current = [];
      setCommandError(fmtError(error));
    } finally {
      setCommandPending(false);
    }
  }

  function doPrimary() {
    if (ss === "idle") void startSessionFlow("start_session", "manual");
    else if (isRec) void runCmd("stop_recording");
    else void stopSessionFlow();
  }

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

  function readMinimalShellSize(nextOrientation: Orientation) {
    const fallback = MINIMAL_WINDOW_SIZE[nextOrientation];
    const shell = minimalShellRef.current;

    if (!shell || nextOrientation !== orientation) {
      console.log("[MirrorSim] fitMinimalWindow: using fallback size", {
        reason: !shell ? "missing-shell-ref" : "orientation-mismatch",
        nextOrientation,
        currentOrientation: orientation,
        fallback,
      });
      return fallback;
    }

    const rect = shell.getBoundingClientRect();
    const measured = {
      width: Math.max(fallback.width, Math.ceil(rect.width)),
      height: Math.max(fallback.height, Math.ceil(rect.height)),
    };

    console.log("[MirrorSim] fitMinimalWindow: measured shell", {
      nextOrientation,
      currentOrientation: orientation,
      rect: {
        width: rect.width,
        height: rect.height,
      },
      fallback,
      measured,
    });

    return measured;
  }

  async function fitMinimalWindow(nextOrientation: Orientation) {
    const win = getCurrentWindow();
    const { width, height } = readMinimalShellSize(nextOrientation);
    console.log("[MirrorSim] fitMinimalWindow: requested resize", {
      nextOrientation,
      target: { width, height },
    });

    // Each call is independent — a failure in one must not block the others
    try {
      await win.setMinSize(null);
      console.log("[MirrorSim] fitMinimalWindow: cleared min size");
    } catch (error) {
      console.error("[MirrorSim] fitMinimalWindow: setMinSize(null) failed", error);
    }

    try {
      await win.setMaxSize(null);
      console.log("[MirrorSim] fitMinimalWindow: cleared max size");
    } catch (error) {
      console.error("[MirrorSim] fitMinimalWindow: setMaxSize(null) failed", error);
    }

    try {
      await win.setSize(new LogicalSize(width, height));
      console.log("[MirrorSim] fitMinimalWindow: setSize succeeded", { width, height });
    } catch (error) {
      console.error("[MirrorSim] fitMinimalWindow: setSize failed", error);
      setCommandError(`Fit resize failed: ${fmtError(error)}`);
    }

    try {
      await win.setMinSize(new LogicalSize(width, height));
      console.log("[MirrorSim] fitMinimalWindow: setMinSize succeeded", { width, height });
    } catch (error) {
      console.error("[MirrorSim] fitMinimalWindow: setMinSize(target) failed", error);
    }
  }

  async function goMinimal() {
    setAppMode("minimal");
    setZoom(1);
    await fitMinimalWindow(orientation);
  }

  async function goConsole() {
    setAppMode("console");
    setZoom(1);
    const win = getCurrentWindow();
    try { await win.setMinSize(null); } catch { /* ignore */ }
    try { await win.setMaxSize(null); } catch { /* ignore */ }
    try { await win.setSize(new LogicalSize(860, 720)); } catch { /* ignore */ }
    try { await win.setMinSize(new LogicalSize(700, 580)); } catch { /* ignore */ }
  }

  const latestSavedCapture = [...captures].reverse().find((capture) => capture.type === "screenshot" && capture.filePath);

  const settingsModal = settingsOpen ? (
    <div
      className="fixed inset-0 z-[240] flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm"
      onMouseDown={() => setSettingsOpen(false)}
    >
      <div
        className="w-full max-w-[460px] rounded-[28px] border border-white/10 bg-[#17191d] p-5 shadow-[0_24px_72px_rgba(0,0,0,0.52)]"
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
            onClick={() => setSettingsOpen(false)}
          >
            Close
          </button>
        </div>

        <div className="mt-5 space-y-4">
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
                    onClick={() => void chooseScreenshotFolder().catch((error) => setCommandError(fmtError(error)))}
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
                    onClick={() => void chooseRecordingFolder().catch((error) => setCommandError(fmtError(error)))}
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
  ) : null;

  // ── device frame (shared between both modes) ──────────────────────────────

  function renderDevice(opts: {
    onContextMenu?: (e: React.MouseEvent) => void;
    onWheel?: (e: React.WheelEvent) => void;
  }) {
    return (
      <div
        className={cn(
          "relative isolate overflow-hidden border border-white/8 bg-[linear-gradient(180deg,#24262b_0%,#111214_16%,#0a0b0d_100%)] p-[1.5px]",
          appMode === "minimal"
            ? "shadow-[0_18px_36px_rgba(0,0,0,0.28),0_0_0_1px_rgba(255,255,255,0.06)]"
            : "shadow-[0_0_0_1px_rgba(255,255,255,0.08),0_34px_80px_rgba(0,0,0,0.76)]",
          deviceWidthClass,
        )}
        style={{ width: deviceFrameWidth }}
        onContextMenu={opts.onContextMenu}
        onWheel={opts.onWheel}
      >
        <div className="pointer-events-none absolute inset-x-[10%] top-[1px] h-5 rounded-full bg-white/[0.07] blur-xl" />
        <div className="pointer-events-none absolute inset-y-[16%] left-[2px] w-[1px] bg-white/[0.07]" />
        <div className="pointer-events-none absolute inset-y-[20%] right-[2px] w-[1px] bg-black/35" />
        <div
          className={cn(
            "relative bg-[linear-gradient(180deg,#0f1013_0%,#080909_22%,#060607_100%)] p-[5px] transition-transform duration-150",
            screenshotFlashActive && "scale-[0.992]",
            orientation === "portrait" ? "rounded-[49px]" : "rounded-[36px]",
          )}
        >
          <div className="pointer-events-none absolute inset-x-3 top-2 h-10 rounded-full bg-white/[0.025] blur-2xl" />
          <div className="pointer-events-none absolute inset-x-3 bottom-2 h-10 rounded-full bg-black/18 blur-2xl" />
          <div
            className={cn(
              "pointer-events-none absolute inset-[5px] rounded-[inherit] border border-white/[0.035]",
              orientation === "portrait" ? "rounded-[45px]" : "rounded-[33px]",
            )}
          />
          <div className="absolute left-1/2 top-[12px] z-10 h-[33px] w-[118px] -translate-x-1/2 rounded-full bg-black shadow-[inset_0_1px_0_rgba(255,255,255,0.04),0_1px_6px_rgba(0,0,0,0.4)]" />
          <div className={screenFrameClass}>
            <div
              className={cn(
                "absolute inset-0 rounded-inherit bg-black",
                (ss === "discovering" || ss === "connecting") && "animate-pulse",
              )}
            >
              <div className="absolute inset-0 overflow-hidden rounded-inherit">
                <video
                  ref={(el) => setVideoEl(el)}
                  className={cn("h-full w-full object-cover transition-opacity", previewDimClass)}
                  muted
                  playsInline
                />
              </div>
              {tone !== "live" ? (
                <div
                  className={cn(
                    "absolute inset-0",
                    tone === "warning"
                      ? "bg-gradient-to-b from-red-950/10 to-red-950/55"
                      : "bg-gradient-to-b from-slate-950/10 to-slate-950/50",
                  )}
                />
              ) : null}
              <div
                className={cn(
                  "pointer-events-none absolute inset-0 bg-white transition-all duration-200",
                  screenshotFlashActive ? "opacity-75" : "opacity-0",
                )}
              />
            </div>
            {!isLive && (
              <div className="absolute inset-0 z-20 flex flex-col items-center justify-center gap-2.5 text-white/30">
                <span className="opacity-30">
                  <Icon name="phone" size={28} />
                </span>
                <span className="text-xs tracking-[-0.01em] text-white/30">Waiting for device</span>
                {ss === "idle" && (
                  <button
                    type="button"
                    className="mt-1 rounded-xl border border-white/7 bg-[#1a1b1e] px-3.5 py-1.5 text-xs font-medium text-white/60 transition hover:border-white/12 hover:text-white"
                    onClick={doPrimary}
                  >
                    Discover devices
                  </button>
                )}
              </div>
            )}
          </div>
        </div>
        {isRec && (
          <div className="absolute right-3.5 top-3 z-30 inline-flex items-center gap-1.5 rounded-full border border-red-500/30 bg-black/75 px-2.5 py-1 text-[11px] font-semibold tracking-[0.02em] text-red-300">
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-red-500" />
            REC {fmtDuration(recElapsed)}
          </div>
        )}
      </div>
    );
  }

  // ── console view ──────────────────────────────────────────────────────────

  if (appMode === "console") {
    return (
      <div className="grid h-screen overflow-hidden bg-[#0e0f11] text-white [grid-template-rows:36px_1fr_48px_36px]">
        <div className={cn("grid grid-cols-[auto_1fr_auto] items-center gap-3 border-b px-3.5", panelSurfaceClass)}>
          <TrafficLights />
          <div
            className="flex h-full items-center justify-center"
            onMouseDown={(event) => void startWindowDrag(event)}
          >
            <div className="flex items-center gap-2">
              <span className="select-none text-[13px] font-semibold tracking-[-0.015em] text-white/90">MirrorSim</span>
              {renderReconnectBadge()}
            </div>
          </div>
          <div className="flex items-center justify-end gap-1.5">
            {isRec && renderStatusBadge(`● REC ${fmtDuration(recElapsed)}`, true)}
            {isLive && !isRec && renderStatusBadge("● Live", true)}
            {isLive && (
              <span className="inline-flex items-center rounded-full border border-white/7 bg-[#1a1b1e] px-2 py-0.5 text-[11px] font-medium tracking-[-0.01em] text-white/55">
                H.264 · {preview.fps > 0 ? `${preview.fps} fps` : "—"}
              </span>
            )}
            {isConnected && renderStatusBadge(session.deviceName)}
            <button
              type="button"
              className="inline-flex items-center rounded-full border border-white/7 bg-[#1a1b1e] px-2 py-0.5 text-[11px] font-medium tracking-[-0.01em] text-white/55 transition hover:border-white/12 hover:text-white"
              onClick={() => void goMinimal()}
              title="Switch to Minimal view (⌘M)"
            >
              Minimal
            </button>
          </div>
        </div>

        <div className="grid min-h-0 grid-cols-[52px_1fr_252px] overflow-hidden">
          <aside className={cn("flex flex-col items-center border-r py-2.5", panelSurfaceClass)}>
            <div className="flex flex-1 flex-col items-center gap-0.5">
              <button
                type="button"
                className={cn(sideButtonClass, isConnected && "bg-emerald-500/10 text-emerald-400")}
                onClick={doPrimary}
                disabled={commandPending}
                title={isConnected ? "Disconnect" : "Discover device"}
              >
                <Icon name="phone" />
              </button>
              <button
                type="button"
                className={sideButtonClass}
                onClick={() => void doCapture()}
                disabled={!canCapture || commandPending}
                title="Screenshot (⌘S)"
              >
                <Icon name="camera" />
              </button>
              <button
                type="button"
                className={cn(sideButtonClass, isRec && "bg-red-500/15 text-red-300")}
                onClick={() => void doRecordToggle()}
                disabled={!canRecord || commandPending}
                title="Toggle recording (⌘R)"
              >
                <Icon name="record" />
              </button>
            </div>
            <div className="flex flex-col items-center gap-0.5">
              <button
                type="button"
                className={sideButtonClass}
                onClick={() =>
                  setOrientation((v) => (v === "portrait" ? "landscape" : "portrait"))
                }
                title="Rotate device"
              >
                <Icon name="rotate" />
              </button>
            </div>
          </aside>

          <div
            className="relative flex items-center justify-center overflow-hidden bg-[#0e0f11]"
            onWheel={(e) => {
              e.preventDefault();
              adjustZoom(e.deltaY < 0 ? 1 : -1);
            }}
          >
            <div className="origin-center transition-transform duration-200" style={{ transform: `scale(${zoom})` }}>
              {renderDevice({})}
            </div>
          </div>

          <aside className={cn("flex min-h-0 flex-col overflow-hidden border-l", panelSurfaceClass)}>
            <div className="flex flex-col gap-2 border-b border-white/7 p-3.5">
              <div className="text-[10px] font-semibold uppercase tracking-[0.08em] text-white/25">Session</div>
              <div className="text-[10px] font-medium uppercase tracking-[0.05em] text-white/25">Connected Device</div>
              {isConnected ? (
                <>
                  <div className="flex items-center gap-2">
                    <div className="flex h-6.5 w-6.5 shrink-0 items-center justify-center rounded-[5px] bg-[#1a1b1e] text-white/55">
                      <Icon name="phone" size={13} />
                    </div>
                    <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                      <span className="truncate text-xs font-medium text-white/90">{session.deviceName}</span>
                      <span className="text-[11px] text-white/25">iOS 17.2 · AirPlay</span>
                    </div>
                    <div className={cn("h-1.5 w-1.5 rounded-full", isLive ? "bg-emerald-400" : "bg-amber-300")} />
                  </div>
                  <button
                    type="button"
                    className="inline-flex items-center gap-1.5 self-start rounded-[5px] border border-white/7 bg-[#1a1b1e] px-2.5 py-1 text-[11px] font-medium text-white/55 transition hover:border-white/12 hover:text-white"
                    onClick={() => void startSessionFlow("reconnect_session", "manual")}
                    disabled={commandPending || isRec}
                  >
                    <Icon name="reconnect" size={12} />
                    Reconnect
                  </button>
                </>
              ) : (
                <div className="flex items-center justify-between text-[11px] text-white/25">
                  <span>No device connected</span>
                  <button
                    type="button"
                    className="inline-flex items-center rounded-[5px] border border-white/7 bg-[#1a1b1e] px-2.5 py-1 text-[11px] font-medium text-white/55 transition hover:border-white/12 hover:text-white"
                    onClick={doPrimary}
                  >
                    Discover
                  </button>
                </div>
              )}
            </div>

            <div className="flex min-h-0 flex-1 flex-col gap-2 border-b border-white/7 p-3.5">
              <div className="text-[10px] font-semibold uppercase tracking-[0.08em] text-white/25">Captures</div>
              <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
                {captures.length === 0 ? (
                  <div className="py-1 text-[11px] text-white/25">No captures yet</div>
                ) : (
                  [...captures].reverse().map((cap) => (
                    <div key={cap.id} className="flex items-center gap-2 border-b border-white/7 py-2 last:border-b-0">
                      <div
                        className={cn(
                          "flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded text-[11px]",
                          cap.type === "screenshot"
                            ? "bg-emerald-500/12 text-emerald-400"
                            : "bg-red-500/14 text-red-300",
                        )}
                      >
                        <Icon name={cap.type === "screenshot" ? "camera" : "record"} size={11} />
                      </div>
                      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                        <span className="truncate text-[11px] text-white/90">{cap.name}</span>
                        {cap.duration !== undefined && (
                          <span className="text-[10px] text-white/25">{fmtDuration(cap.duration)}</span>
                        )}
                      </div>
                      {cap.filePath && (
                        <button
                          type="button"
                          className="inline-flex items-center rounded-[5px] border border-white/7 bg-[#1a1b1e] px-2 py-1 text-[10px] font-medium text-white/55 transition hover:border-white/12 hover:text-white"
                          onClick={() => void revealCaptureInExplorer(cap).catch((error) => setCommandError(fmtError(error)))}
                        >
                          Reveal
                        </button>
                      )}
                    </div>
                  ))
                )}
              </div>
            </div>

            <div className="mt-auto">
              <button
                type="button"
                className="flex w-full items-center gap-1.5 px-3.5 py-2.5 text-left text-[11px] font-medium text-white/25 transition hover:text-white/55"
                onClick={() => setDiagExpanded((v) => !v)}
              >
                <Icon name={diagExpanded ? "chevron-down" : "chevron-right"} size={13} />
                Diagnostics
              </button>
              {diagExpanded && (
                <div className="flex max-h-[220px] flex-col gap-1.5 overflow-y-auto px-3.5 pb-3">
                  {(
                    [
                      ["State", ss],
                      ["FPS", String(preview.fps)],
                      ["Bitrate", `${(preview.bitrateKbps / 1000).toFixed(1)} Mbps`],
                      ["Latency", `${preview.latencyMs} ms`],
                      ["Frames", String(preview.frameNumber)],
                      ["Buffer", `+${bufferedAhead.toFixed(2)}s`],
                      ["Queued", String(previewDiag.queuedSegments)],
                      ["Init", previewDiag.initSegmentReady ? "ready" : "waiting"],
                      ["Appended", String(previewClientDiag.mediaAppendCount)],
                      ["Errors", String(previewClientDiag.appendErrorCount)],
                      ["Transport", receiverRuntime.transport],
                      [
                        "Last error",
                        receiverRuntime.lastError ?? surfaceError ?? commandError ?? "—",
                      ],
                    ] as [string, string][]
                  ).map(([k, v]) => (
                    <div key={k} className="flex items-center justify-between gap-3 text-[11px]">
                      <span className="text-white/25">{k}</span>
                      <strong className="max-w-[60%] truncate text-right font-medium text-white/90">{v}</strong>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </aside>
        </div>

        <div className={cn("flex items-center justify-between gap-1 border-y px-3", panelSurfaceClass)}>
          <div className="flex items-center gap-px">
            <button
              type="button"
              className={cn(controlButtonClass, isRec && "bg-red-500/15 text-red-300")}
              onClick={() => void doRecordToggle()}
              disabled={!canRecord || commandPending}
              title="Toggle recording (⌘R)"
            >
              <Icon name="record" size={15} />
            </button>
            <button
              type="button"
              className={controlButtonClass}
              onClick={() => void doCapture()}
              disabled={!canCapture || commandPending}
              title="Screenshot (⌘S)"
            >
              <Icon name="camera" size={15} />
            </button>
            <div className="mx-1.5 h-4 w-px bg-white/7" />
            <button
              type="button"
              className={controlButtonClass}
              onClick={() => void getCurrentWindow().toggleMaximize()}
              title="Fullscreen (⌘F)"
            >
              <Icon name="fullscreen" size={15} />
            </button>
            <button
              type="button"
              className={controlButtonClass}
              onClick={() => adjustZoom(-1)}
              disabled={zoomIndex === 0}
              title="Zoom out"
            >
              <Icon name="zoom-out" size={15} />
            </button>
            <span className="min-w-[26px] text-center text-[11px] font-semibold tracking-[-0.03em] text-white/55">{zoom}×</span>
            <button
              type="button"
              className={controlButtonClass}
              onClick={() => adjustZoom(1)}
              disabled={zoomIndex === ZOOM_LEVELS.length - 1}
              title="Zoom in"
            >
              <Icon name="zoom-in" size={15} />
            </button>
            <div className="mx-1.5 h-4 w-px bg-white/7" />
            <button
              type="button"
              className={controlButtonClass}
              onClick={() =>
                setOrientation((v) => (v === "portrait" ? "landscape" : "portrait"))
              }
              title="Rotate device"
            >
              <Icon name="rotate" size={15} />
            </button>
          </div>
          <div className="flex items-center gap-px">
            <button type="button" className={controlButtonClass} title="Settings" onClick={openScreenshotSettings}>
              <Icon name="settings" size={15} />
            </button>
          </div>
        </div>

        <div className="flex items-center gap-0 bg-[#0e0f11] px-4">
          <div className="flex items-center gap-2">
            <span className="text-[11px] tracking-[-0.01em] text-white/25">Latency</span>
            <strong className="text-[11px] font-semibold tracking-[-0.02em] text-white/90">{isLive ? `${preview.latencyMs} ms` : "—"}</strong>
          </div>
          <div className="mx-3.5 h-3 w-px bg-white/7" />
          <div className="flex items-center gap-2">
            <span className="text-[11px] tracking-[-0.01em] text-white/25">Frame rate</span>
            <strong className="text-[11px] font-semibold tracking-[-0.02em] text-white/90">{isLive ? `${preview.fps} fps` : "—"}</strong>
          </div>
          <div className="mx-3.5 h-3 w-px bg-white/7" />
          <div className="flex items-center gap-2">
            <span className="text-[11px] tracking-[-0.01em] text-white/25">Bitrate</span>
            <strong className="text-[11px] font-semibold tracking-[-0.02em] text-white/90">
              {isLive ? `${(preview.bitrateKbps / 1000).toFixed(1)} Mbps` : "—"}
            </strong>
          </div>
          <div className="mx-3.5 h-3 w-px bg-white/7" />
          <div className="flex items-center gap-2">
            <span className="text-[11px] tracking-[-0.01em] text-white/25">Resolution</span>
            <strong className="text-[11px] font-semibold tracking-[-0.02em] text-white/90">
              {isLive ? (orientation === "portrait" ? "393×852" : "852×393") : "—"}
            </strong>
          </div>
        </div>
        {settingsModal}
      </div>
    );
  }

  // ── minimal view ──────────────────────────────────────────────────────────

  return (
    <div className="flex h-screen w-screen flex-col items-center overflow-hidden bg-transparent text-white">
      <div ref={minimalShellRef} className="inline-flex flex-col" style={{ width: MINIMAL_SHELL_WIDTH[orientation] }}>
        {/* Slim titlebar — snaps to the visible phone shell width instead of stretching across the window */}
        <div
          className="flex h-10 w-full shrink-0 items-center justify-between border-b border-white/8 bg-[#17191d] px-2"
          onMouseDown={(event) => void startWindowDrag(event)}
        >
          <div className="flex items-center gap-2">
            <TrafficLights />
            <div className="flex items-center gap-1.5 leading-none">
              <span className="select-none text-[11px] font-semibold tracking-[-0.015em] text-white/90">{session.deviceName}</span>
              {renderReconnectBadge(true)}
            </div>
          </div>
          <div className="flex items-center gap-0.5" onMouseDown={(event) => event.stopPropagation()}>
            <button
              type="button"
              className={minimalFloatingButtonClass}
              onClick={() => void doCapture()}
              disabled={!canCapture || commandPending}
              title="Screenshot (⌘S)"
            >
              <Icon name="camera" size={14} />
            </button>
            <button
              type="button"
              className={cn(minimalFloatingButtonClass, isRec && "bg-red-500/15 text-red-300 hover:bg-red-500/20")}
              onClick={() => void doRecordToggle()}
              disabled={!canRecord || commandPending}
              title="Toggle recording (⌘R)"
            >
              <Icon name="record" size={14} />
            </button>
            <button
              type="button"
              className={minimalFloatingButtonClass}
              onClick={() => {
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
              title="Rotate device"
            >
              <Icon name="rotate" size={14} />
            </button>
            <button
              type="button"
              className={minimalFloatingButtonClass}
              onClick={openScreenshotSettings}
              title="Screenshot settings"
            >
              <Icon name="settings" size={14} />
            </button>
            <button
              type="button"
              className={minimalFloatingButtonClass}
              onClick={() => {
                console.log("[MirrorSim] fit button clicked", {
                  orientation,
                  shellPresent: Boolean(minimalShellRef.current),
                });
                void fitMinimalWindow(orientation);
              }}
              title="Snap window to fit phone"
            >
              <Icon name="compress" size={14} />
            </button>
            <button
              type="button"
              className="inline-flex h-7 items-center justify-center gap-1 rounded-full border border-cyan-400/22 bg-cyan-400/10 px-2 text-[10px] font-semibold tracking-[-0.01em] text-cyan-100 transition hover:bg-cyan-400/16 hover:text-white"
              onClick={() => void goConsole()}
              title="Switch to Console view (⌘M)"
            >
              <Icon name="console" size={12} />
              <span>Console</span>
            </button>
          </div>
        </div>

        {renderDevice({
          onContextMenu: (e) => {
            e.preventDefault();
            setContextMenu({ x: e.clientX, y: e.clientY });
          },
        })}
      </div>

      {contextMenu && (
        <div
          className="fixed z-[200] min-w-[196px] rounded-xl border border-white/12 bg-[#1e2023] p-1 shadow-[0_16px_48px_rgba(0,0,0,0.56),0_4px_12px_rgba(0,0,0,0.32)]"
          style={{ left: contextMenu.x, top: contextMenu.y }}
          onPointerDown={(e) => e.stopPropagation()}
        >
          <button
            type="button"
            className="flex w-full items-center rounded-[5px] px-2.5 py-1.5 text-left text-xs tracking-[-0.01em] text-white transition hover:bg-white/8 disabled:cursor-default disabled:text-white/25"
            onClick={() => {
              void doCapture();
              setContextMenu(null);
            }}
            disabled={!canCapture}
          >
            Take Screenshot
          </button>
          <button
            type="button"
            className="flex w-full items-center rounded-[5px] px-2.5 py-1.5 text-left text-xs tracking-[-0.01em] text-white transition hover:bg-white/8 disabled:cursor-default disabled:text-white/25"
            onClick={() => {
              void doCapture({ copyToClipboard: true, saveToDisk: false });
              setContextMenu(null);
            }}
            disabled={!canCapture}
          >
            Copy to Clipboard
          </button>
          <div className="my-1 h-px bg-white/7" />
          <button
            type="button"
            className="flex w-full items-center rounded-[5px] px-2.5 py-1.5 text-left text-xs tracking-[-0.01em] text-white transition hover:bg-white/8 disabled:cursor-default disabled:text-white/25"
            onClick={() => {
              void doRecordToggle();
              setContextMenu(null);
            }}
            disabled={!canRecord}
          >
            {isRec ? "Stop Recording" : "Start Recording"}
          </button>
          <div className="my-1 h-px bg-white/7" />
          <button
            type="button"
            className="flex w-full items-center rounded-[5px] px-2.5 py-1.5 text-left text-xs tracking-[-0.01em] text-white transition hover:bg-white/8 disabled:cursor-default disabled:text-white/25"
            onClick={() => {
              void doCapture({ saveToDisk: true, copyToClipboard: false, saveLocation: "documents" });
              setContextMenu(null);
            }}
            disabled={!canCapture}
          >
            Save to Documents
          </button>
          <button
            type="button"
            className="flex w-full items-center rounded-[5px] px-2.5 py-1.5 text-left text-xs tracking-[-0.01em] text-white transition hover:bg-white/8 disabled:cursor-default disabled:text-white/25"
            onClick={() => {
              void revealCaptureInExplorer(latestSavedCapture).catch((error) => setCommandError(fmtError(error)));
              setContextMenu(null);
            }}
            disabled={!latestSavedCapture?.filePath}
          >
            Open in Explorer
          </button>
          <div className="my-1 h-px bg-white/7" />
          <button
            type="button"
            className="flex w-full items-center rounded-[5px] px-2.5 py-1.5 text-left text-xs tracking-[-0.01em] text-white transition hover:bg-white/8 disabled:cursor-default disabled:text-white/25"
            onClick={() => {
              adjustZoom(1);
              setContextMenu(null);
            }}
            disabled={ZOOM_LEVELS.indexOf(zoom) === ZOOM_LEVELS.length - 1}
          >
            Zoom In
          </button>
          <button
            type="button"
            className="flex w-full items-center rounded-[5px] px-2.5 py-1.5 text-left text-xs tracking-[-0.01em] text-white transition hover:bg-white/8 disabled:cursor-default disabled:text-white/25"
            onClick={() => {
              adjustZoom(-1);
              setContextMenu(null);
            }}
            disabled={ZOOM_LEVELS.indexOf(zoom) === 0}
          >
            Zoom Out
          </button>
          <button
            type="button"
            className="flex w-full items-center rounded-[5px] px-2.5 py-1.5 text-left text-xs tracking-[-0.01em] text-white transition hover:bg-white/8"
            onClick={() => {
              setZoom(1);
              setContextMenu(null);
            }}
          >
            Fit to Screen
          </button>
          <div className="my-1 h-px bg-white/7" />
          <button
            type="button"
            className="flex w-full items-center rounded-[5px] px-2.5 py-1.5 text-left text-xs tracking-[-0.01em] text-white transition hover:bg-white/8"
            onClick={() => {
              openScreenshotSettings();
              setContextMenu(null);
            }}
          >
            Screenshot Settings
          </button>
          <div className="my-1 h-px bg-white/7" />
          <button
            type="button"
            className="flex w-full items-center rounded-[5px] px-2.5 py-1.5 text-left text-xs tracking-[-0.01em] text-white transition hover:bg-white/8"
            onClick={() => {
              void goConsole();
              setContextMenu(null);
            }}
          >
            Switch to Console View
          </button>
          <div className="my-1 h-px bg-white/7" />
          <button
            type="button"
            className="flex w-full items-center rounded-[5px] px-2.5 py-1.5 text-left text-xs tracking-[-0.01em] text-red-300 transition hover:bg-red-500/15"
            onClick={() => void getCurrentWindow().close()}
          >
            Close
          </button>
        </div>
      )}
      {settingsModal}
    </div>
  );
}
