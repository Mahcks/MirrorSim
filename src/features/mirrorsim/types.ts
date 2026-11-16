export type AppMode = "console" | "minimal";
export type Orientation = "portrait" | "landscape";
export type PreviewQualityPreset = "quality" | "balanced" | "speed";
export type ReceiverAccessMode = "ask" | "remember-trusted" | "known-only";
export type AudioChannelMode = "stereo" | "mono";
export type SessionState = "idle" | "discovering" | "connecting" | "mirroring" | "recording";
export type SessionCommand =
  | "get_session_snapshot"
  | "get_preview_telemetry"
  | "get_preview_stream_descriptor"
  | "get_preview_init_segment"
  | "prepare_preview_decoder_stream"
  | "take_preview_video_access_unit"
  | "take_preview_media_segment"
  | "prepare_preview_media_stream"
  | "take_preview_audio_frames"
  | "report_preview_client_diagnostics"
  | "get_preview_diagnostics"
  | "get_receiver_runtime"
  | "get_bonjour_status"
  | "get_pairing_snapshot"
  | "get_trusted_devices"
  | "get_connection_history"
  | "refresh_receiver_readiness"
  | "start_session"
  | "reconnect_session"
  | "stop_session"
  | "confirm_pairing_trust"
  | "cancel_pairing"
  | "trust_current_device"
  | "forget_trusted_device"
  | "rename_trusted_device"
  | "set_trusted_device_blocked"
  | "reset_trusted_devices"
  | "open_windows_services"
  | "open_windows_firewall"
  | "export_diagnostics_report"
  | "take_screenshot"
  | "start_recording"
  | "stop_recording";

export type SessionSnapshot = {
  status: SessionState;
  captureCount: number;
  deviceName: string;
  currentDeviceId: string | null;
  currentDeviceModel: string | null;
  currentDeviceOsName: string | null;
  currentDeviceOsVersion: string | null;
  currentDeviceOsBuildVersion: string | null;
  currentDeviceSourceVersion: string | null;
  currentDeviceKey: string | null;
  currentDeviceNickname: string | null;
  currentDeviceKnown: boolean;
  currentDeviceTrusted: boolean;
  currentDeviceBlocked: boolean;
  currentDeviceBlockedReason: string | null;
  receiverId: string | null;
  receiverProtocolVersion: string | null;
  receiverCapabilities: string[];
};

export type TrustedDevice = {
  key: string;
  deviceId: string | null;
  displayName: string;
  model: string | null;
  osName: string | null;
  osVersion: string | null;
  osBuildVersion: string | null;
  sourceVersion: string | null;
  nickname: string | null;
  firstSeenAt: number;
  lastSeenAt: number;
  trustedAt: number | null;
  lastSuccessfulConnectionAt: number | null;
  lastPairingAt: number | null;
  pendingPairing: boolean;
  isBlocked: boolean;
  blockedReason: string | null;
  lastFailureAt: number | null;
  lastFailureReason: string | null;
};

export type ConnectionHistoryEntry = {
  id: string;
  occurredAt: number;
  event: string;
  status: string;
  message: string;
  deviceName: string | null;
  deviceId: string | null;
  deviceModel: string | null;
  deviceOsName: string | null;
  deviceOsVersion: string | null;
  deviceKey: string | null;
  receiverName: string | null;
};

export type DiagnosticsExport = {
  fileName: string;
  filePath: string;
  exportedAt: number;
  entryCount: number;
};

export type AppUpdateInfo = {
  version: string;
  currentVersion: string;
  notes: string | null;
  pubDate: string | null;
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
  videoWidth: number;
  videoHeight: number;
  totalVideoFrames: number;
  droppedVideoFrames: number;
  playbackRate: number;
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

export type DeviceFrameColor = "black" | "silver" | "gold" | "blue";
export type CaptureBackground = "none" | "color" | "gradient";
export type CaptureGradient = "sunset" | "ocean" | "aurora" | "blush" | "graphite";

/** How framed screenshots and recordings look. Shared by both. */
export type CaptureStyle = {
  frameColor: DeviceFrameColor;
  background: CaptureBackground;
  /** Hex color, e.g. "#f2f2f7", used when background is "color". */
  backgroundColor: string;
  gradient: CaptureGradient;
};

export type ScreenshotSettings = {
  saveToDisk: boolean;
  copyToClipboard: boolean;
  saveLocation: ScreenshotSaveLocation;
  customSavePath: string;
  fileNamePrefix: string;
  includeTimestamp: boolean;
  includeDeviceFrame: boolean;
};

export type RecordingFormat = "mp4" | "webm";
export type RecordingCountdown = 0 | 3 | 5;

export type RecordingSettings = {
  format: RecordingFormat;
  saveLocation: ScreenshotSaveLocation;
  customSavePath: string;
  fileNamePrefix: string;
  includeTimestamp: boolean;
  autoReveal: boolean;
  includeDeviceFrame: boolean;
  includeAudio: boolean;
  /** Seconds of 3-2-1 countdown before recording starts; 0 starts at once. */
  countdownSeconds: RecordingCountdown;
  /** Evens out quiet and loud iPhone audio in recordings only. */
  normalizeAudio: boolean;
};

/** Live recording state shared by the views that show recording controls. */
export type RecordingControls = {
  /** Seconds left before recording starts, or null when no countdown runs. */
  countdown: number | null;
  paused: boolean;
  /** Bytes recorded so far. */
  bytes: number;
  onPauseToggle: () => void;
};

export type KeyboardShortcutAction =
  | "toggleAudio"
  | "takeScreenshot"
  | "toggleRecording"
  | "togglePauseRecording"
  | "toggleView"
  | "toggleFullscreen"
  | "toggleMinimalChrome"
  | "openPreferences"
  | "toggleDiagnostics";

export type KeyboardShortcutMap = Record<KeyboardShortcutAction, string[]>;

export type AppPreferences = {
  launchMode: AppMode;
  previewQualityPreset: PreviewQualityPreset;
  receiverAccessMode: ReceiverAccessMode;
  useOpaqueWindowBackground: boolean;
  rememberLastMode: boolean;
  rememberLastOrientation: boolean;
  autoRotateFromIphone: boolean;
  keepMinimalOnTop: boolean;
  autoRevealSavedCaptures: boolean;
  screenshotFlashEnabled: boolean;
  autoStartDiscovery: boolean;
  autoReconnectOnDrop: boolean;
  openDiagnosticsOnError: boolean;
  audioMuted: boolean;
  audioVolume: number;
  followIphoneVolume: boolean;
  audioChannelMode: AudioChannelMode;
  keyboardShortcuts: KeyboardShortcutMap;
  receiverDisplayName: string;
  captureStyle: CaptureStyle;
  lastMode: AppMode;
  lastOrientation: Orientation;
};

export type StoredPreferences = {
  screenshots?: Partial<ScreenshotSettings>;
  recordings?: Partial<RecordingSettings>;
  app?: Partial<AppPreferences>;
  _meta?: {
    revision: number;
    updatedAt: number;
  };
};

export type ScreenshotCaptureOverrides = Partial<
  Pick<ScreenshotSettings, "saveToDisk" | "copyToClipboard" | "saveLocation" | "customSavePath">
>;

export type SavedCaptureFile = {
  fileName: string;
  filePath: string;
};

export type PreviewAudioFrame = {
  streamId: string;
  pts: number;
  sampleRate: number;
  channels: number;
  bitsPerSample: number;
  payloadBase64: string;
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
  | "console"
  | "volume"
  | "volume-off"
  | "sliders"
  | "wifi"
  | "help"
  | "pause"
  | "play";
