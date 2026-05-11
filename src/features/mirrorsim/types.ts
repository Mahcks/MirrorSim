export type AppMode = "console" | "minimal";
export type Orientation = "portrait" | "landscape";
export type PreviewQualityPreset = "quality" | "balanced" | "speed";
export type SessionState = "idle" | "discovering" | "connecting" | "mirroring" | "recording";
export type SessionCommand =
  | "get_session_snapshot"
  | "get_preview_telemetry"
  | "get_preview_stream_descriptor"
  | "get_preview_init_segment"
  | "take_preview_media_segment"
  | "get_preview_diagnostics"
  | "get_receiver_runtime"
  | "get_bonjour_status"
  | "refresh_receiver_readiness"
  | "start_session"
  | "reconnect_session"
  | "stop_session"
  | "open_windows_services"
  | "take_screenshot"
  | "start_recording"
  | "stop_recording";

export type SessionSnapshot = {
  status: SessionState;
  captureCount: number;
  deviceName: string;
  receiverId: string | null;
  receiverProtocolVersion: string | null;
  receiverCapabilities: string[];
};

export type PreviewTelemetry = {
  frameNumber: number;
  fps: number;
  bitrateKbps: number;
  latencyMs: number;
  activity: number;
};

export type VideoElementDiag = {
  currentTime: number;
  bufferedEnd: number;
  readyState: number;
  paused: boolean;
  totalVideoFrames: number;
  droppedVideoFrames: number;
};

export type Capture = {
  id: string;
  type: "screenshot" | "recording";
  name: string;
  duration?: number;
  addedAt: number;
  filePath?: string;
};

export type ContextMenuPos = { x: number; y: number };
export type ScreenshotSaveLocation = "pictures" | "documents" | "downloads" | "custom";

export type ScreenshotSettings = {
  saveToDisk: boolean;
  copyToClipboard: boolean;
  saveLocation: ScreenshotSaveLocation;
  customSavePath: string;
  fileNamePrefix: string;
  includeTimestamp: boolean;
};

export type RecordingSettings = {
  saveLocation: ScreenshotSaveLocation;
  customSavePath: string;
  fileNamePrefix: string;
  includeTimestamp: boolean;
  autoReveal: boolean;
};

export type AppPreferences = {
  launchMode: AppMode;
  previewQualityPreset: PreviewQualityPreset;
  useOpaqueWindowBackground: boolean;
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

export type StoredPreferences = {
  screenshots?: Partial<ScreenshotSettings>;
  recordings?: Partial<RecordingSettings>;
  app?: Partial<AppPreferences>;
};

export type ScreenshotCaptureOverrides = Partial<
  Pick<ScreenshotSettings, "saveToDisk" | "copyToClipboard" | "saveLocation" | "customSavePath">
>;

export type SavedCaptureFile = {
  fileName: string;
  filePath: string;
};

export type IconName =
  | "phone"
  | "camera"
  | "record"
  | "minimize"
  | "maximize"
  | "close"
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