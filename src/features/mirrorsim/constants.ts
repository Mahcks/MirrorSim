import type { CSSProperties } from "react";

import type {
  AppPreferences,
  Orientation,
  PreviewQualityPreset,
  RecordingSettings,
  ScreenshotSettings,
} from "./types";

export const ZOOM_LEVELS = [0.5, 0.75, 1, 1.5, 2] as const;
export type ZoomLevel = (typeof ZOOM_LEVELS)[number];

export const PREFERENCES_STORAGE_KEY = "mirrorsim.preferences.v1";
export const LEGACY_SCREENSHOT_SETTINGS_STORAGE_KEY = "mirrorsim.screenshot-settings.v1";
export const PREFERENCES_STORE_PATH = "settings.json";
export const PREFERENCES_STORE_KEY = "preferences";

export const SESSION_STATUS_EVENT = "session-status";
export const PREVIEW_TELEMETRY_EVENT = "preview-telemetry";

export const MINIMAL_TITLEBAR_HEIGHT = 44;
export const MINIMAL_SHELL_WIDTH: Record<Orientation, number> = {
  portrait: 393,
  landscape: 736,
};

export const MINIMAL_WINDOW_SIZE: Record<Orientation, { width: number; height: number }> = {
  portrait: { width: MINIMAL_SHELL_WIDTH.portrait, height: 805 + MINIMAL_TITLEBAR_HEIGHT },
  landscape: { width: MINIMAL_SHELL_WIDTH.landscape, height: 361 + MINIMAL_TITLEBAR_HEIGHT },
};

export const DEVICE_RENDER_WIDTH: Record<Orientation, number> = {
  portrait: 393,
  landscape: 736,
};

export const PREVIEW_QUALITY_PRESETS: Record<
  PreviewQualityPreset,
  {
    label: string;
    description: string;
    imageRendering: CSSProperties["imageRendering"];
    filter?: string;
    catchupLeadSeconds: number;
    catchupTargetOffsetSeconds: number;
  }
> = {
  quality: {
    label: "Good quality",
    description: "Sharper scaling with a slightly deeper playback buffer.",
    imageRendering: "auto",
    filter: "saturate(1.02) contrast(1.02)",
    catchupLeadSeconds: 0.45,
    catchupTargetOffsetSeconds: 0.08,
  },
  balanced: {
    label: "Balanced",
    description: "Default live preview tuning for everyday use.",
    imageRendering: "auto",
    catchupLeadSeconds: 0.35,
    catchupTargetOffsetSeconds: 0.06,
  },
  speed: {
    label: "Fast speed",
    description: "More aggressive live-edge catch-up with crisp nearest-neighbor scaling.",
    imageRendering: "pixelated",
    catchupLeadSeconds: 0.25,
    catchupTargetOffsetSeconds: 0.04,
  },
};

export const defaultScreenshotSettings: ScreenshotSettings = {
  saveToDisk: true,
  copyToClipboard: false,
  saveLocation: "pictures",
  customSavePath: "",
  fileNamePrefix: "mirrorsim_screenshot",
  includeTimestamp: true,
  includeDeviceFrame: false,
};

export const defaultRecordingSettings: RecordingSettings = {
  saveLocation: "pictures",
  customSavePath: "",
  fileNamePrefix: "mirrorsim_recording",
  includeTimestamp: true,
  autoReveal: false,
  includeDeviceFrame: false,
};

export const defaultAppPreferences: AppPreferences = {
  launchMode: "minimal",
  previewQualityPreset: "balanced",
  receiverAccessMode: "ask",
  useOpaqueWindowBackground: false,
  rememberLastMode: true,
  rememberLastOrientation: true,
  keepMinimalOnTop: false,
  autoRevealSavedCaptures: false,
  screenshotFlashEnabled: true,
  autoStartDiscovery: false,
  autoReconnectOnDrop: true,
  openDiagnosticsOnError: true,
  audioMuted: false,
  audioVolume: 0.8,
  receiverDisplayName: "MirrorSim",
  lastMode: "minimal",
  lastOrientation: "portrait",
};
