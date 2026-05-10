export const PREVIEW_STREAM_EVENT = "preview-stream";
export const RECEIVER_RUNTIME_EVENT = "receiver-runtime";
export const PREVIEW_DIAGNOSTICS_EVENT = "preview-diagnostics";

export type ReceiverRuntimeState = "idle" | "priming" | "ready" | "streaming";
export type ReceiverTransport = "fixture" | "airplayserver";
export type PreviewDeliveryMode = "static-paths" | "command-stream";

export type PreviewStreamDescriptor = {
  streamId: string;
  transport: ReceiverTransport;
  deliveryMode: PreviewDeliveryMode;
  mimeType: string;
  initSegmentPath: string;
  mediaSegmentPaths: string[];
  shouldLoop: boolean;
};

export type ReceiverRuntimeSnapshot = {
  state: ReceiverRuntimeState;
  transport: ReceiverTransport;
  streamId: string;
  queuedSegments: number;
  lastError: string | null;
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

export const initialReceiverRuntime: ReceiverRuntimeSnapshot = {
  state: "idle",
  transport: "fixture",
  streamId: "fixture-preview-stream",
  queuedSegments: 0,
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