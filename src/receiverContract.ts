export const PREVIEW_STREAM_EVENT = "preview-stream";
export const RECEIVER_RUNTIME_EVENT = "receiver-runtime";
export const PREVIEW_DIAGNOSTICS_EVENT = "preview-diagnostics";
export const PAIRING_STATUS_EVENT = "pairing-status";

export type BonjourStatus = "ready" | "missing" | "stopped" | "unknown";
export type PairingPhase = "idle" | "pin-required" | "awaiting-trust" | "verifying" | "paired" | "failed";
export type PairingEntryMode = "none" | "enter-on-device" | "enter-in-app" | "confirm-only";

export type ReceiverRuntimeState = "idle" | "priming" | "ready" | "streaming";
export type ReceiverTransport = "fixture" | "airplayserver";
export type PreviewDeliveryMode = "static-paths" | "command-stream";

export type PreviewStreamDescriptor = {
  streamId: string;
  configGeneration: number;
  transport: ReceiverTransport;
  deliveryMode: PreviewDeliveryMode;
  mimeType: string;
  codec: string;
  codedWidth: number;
  codedHeight: number;
  decoderConfigHex: string;
  initSegmentPath: string;
  mediaSegmentPaths: string[];
  shouldLoop: boolean;
};

export type ReceiverRuntimeSnapshot = {
  state: ReceiverRuntimeState;
  transport: ReceiverTransport;
  streamId: string;
  queuedSegments: number;
  senderVolumeDb: number | null;
  lastError: string | null;
};

export type BonjourStatusSnapshot = {
  status: BonjourStatus;
  serviceName: string;
  detail: string;
};

export type PreviewDiagnosticsSnapshot = {
  transport: ReceiverTransport;
  initSegmentReady: boolean;
  trackTimescale: number;
  pendingSamples: number;
  queuedSegments: number;
  emittedSegments: number;
  deliveredSegments: number;
  lastAccessUnitIndex: number | null;
  lastAccessUnitDuration: number | null;
  lastQueuedSequenceNumber: number | null;
  lastQueuedFirstSampleIndex: number | null;
  lastQueuedLastSampleIndex: number | null;
  lastQueuedDuration: number | null;
  lastDeliveredSequenceNumber: number | null;
  lastDeliveredFirstSampleIndex: number | null;
  lastDeliveredLastSampleIndex: number | null;
};

export type PairingSnapshot = {
  phase: PairingPhase;
  entryMode: PairingEntryMode;
  sessionId: string | null;
  challengeId: string | null;
  deviceName: string | null;
  deviceId: string | null;
  displayPin: string | null;
  prompt: string | null;
  failureMessage: string | null;
  canTrust: boolean;
};

export const initialReceiverRuntime: ReceiverRuntimeSnapshot = {
  state: "idle",
  transport: "fixture",
  streamId: "fixture-preview-stream",
  queuedSegments: 0,
  senderVolumeDb: null,
  lastError: null,
};

export const initialPreviewDiagnostics: PreviewDiagnosticsSnapshot = {
  transport: "fixture",
  initSegmentReady: true,
  trackTimescale: 90000,
  pendingSamples: 0,
  queuedSegments: 0,
  emittedSegments: 0,
  deliveredSegments: 0,
  lastAccessUnitIndex: null,
  lastAccessUnitDuration: null,
  lastQueuedSequenceNumber: null,
  lastQueuedFirstSampleIndex: null,
  lastQueuedLastSampleIndex: null,
  lastQueuedDuration: null,
  lastDeliveredSequenceNumber: null,
  lastDeliveredFirstSampleIndex: null,
  lastDeliveredLastSampleIndex: null,
};

export const initialBonjourStatus: BonjourStatusSnapshot = {
  status: "unknown",
  serviceName: "Bonjour Service",
  detail: "Checking Bonjour availability...",
};

export const initialPairingStatus: PairingSnapshot = {
  phase: "idle",
  entryMode: "none",
  sessionId: null,
  challengeId: null,
  deviceName: null,
  deviceId: null,
  displayPin: null,
  prompt: null,
  failureMessage: null,
  canTrust: false,
};
