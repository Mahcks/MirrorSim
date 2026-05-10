export type MockPreviewStreamStatus = "loading" | "ready" | "unsupported" | "error";

import { invoke } from "@tauri-apps/api/core";
import type { PreviewStreamDescriptor } from "./receiverContract";

export type PreviewStreamClientDiagnostics = {
  initAppendCount: number;
  mediaAppendCount: number;
  appendErrorCount: number;
  emptyPollCount: number;
  lastAppendedSequenceNumber: number | null;
  lastAppendedBytes: number;
  lastAppendAtMs: number | null;
  sourceBufferUpdating: boolean;
  mediaSourceReadyState: string;
};

export const initialPreviewStreamClientDiagnostics: PreviewStreamClientDiagnostics = {
  initAppendCount: 0,
  mediaAppendCount: 0,
  appendErrorCount: 0,
  emptyPollCount: 0,
  lastAppendedSequenceNumber: null,
  lastAppendedBytes: 0,
  lastAppendAtMs: null,
  sourceBufferUpdating: false,
  mediaSourceReadyState: "closed",
};

type MockPreviewStreamOptions = {
  onStatusChange?: (status: MockPreviewStreamStatus) => void;
  onError?: (message: string) => void;
  onDiagnosticsChange?: (diagnostics: PreviewStreamClientDiagnostics) => void;
};

type PreviewMediaSegmentPayload = {
  sequenceNumber: number;
  firstSampleIndex: number;
  lastSampleIndex: number;
  bytes: number[];
};

function formatStreamError(error: unknown) {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

function waitForSourceOpen(mediaSource: MediaSource, signal: AbortSignal) {
  if (mediaSource.readyState === "open") {
    return Promise.resolve();
  }

  return new Promise<void>((resolve, reject) => {
    const handleOpen = () => {
      cleanup();
      resolve();
    };

    const handleAbort = () => {
      cleanup();
      reject(new DOMException("The preview stream setup was aborted.", "AbortError"));
    };

    const cleanup = () => {
      mediaSource.removeEventListener("sourceopen", handleOpen);
      signal.removeEventListener("abort", handleAbort);
    };

    mediaSource.addEventListener("sourceopen", handleOpen, { once: true });
    signal.addEventListener("abort", handleAbort, { once: true });
  });
}

function appendSegment(sourceBuffer: SourceBuffer, segment: ArrayBuffer) {
  return new Promise<void>((resolve, reject) => {
    const handleUpdateEnd = () => {
      cleanup();
      resolve();
    };

    const handleError = () => {
      cleanup();
      reject(new Error("The preview SourceBuffer rejected a fragment append."));
    };

    const cleanup = () => {
      sourceBuffer.removeEventListener("updateend", handleUpdateEnd);
      sourceBuffer.removeEventListener("error", handleError);
    };

    sourceBuffer.addEventListener("updateend", handleUpdateEnd, { once: true });
    sourceBuffer.addEventListener("error", handleError, { once: true });
    sourceBuffer.appendBuffer(segment);
  });
}

function toArrayBuffer(bytes: number[]) {
  return Uint8Array.from(bytes).buffer;
}

function delay(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      signal.removeEventListener("abort", handleAbort);
      resolve();
    }, ms);

    const handleAbort = () => {
      window.clearTimeout(timeout);
      reject(new DOMException("The preview stream polling was aborted.", "AbortError"));
    };

    signal.addEventListener("abort", handleAbort, { once: true });
  });
}

export function attachMockPreviewStream(
  videoElement: HTMLVideoElement,
  descriptor: PreviewStreamDescriptor,
  options: MockPreviewStreamOptions = {},
) {
  const { onStatusChange, onError, onDiagnosticsChange } = options;

  if (typeof window === "undefined" || !("MediaSource" in window) || !MediaSource.isTypeSupported(descriptor.mimeType)) {
    onStatusChange?.("unsupported");
    return () => {};
  }

  const abortController = new AbortController();
  const mediaSource = new MediaSource();
  const objectUrl = URL.createObjectURL(mediaSource);
  let disposed = false;
  let sourceBuffer: SourceBuffer | null = null;
  let diagnostics = { ...initialPreviewStreamClientDiagnostics, mediaSourceReadyState: mediaSource.readyState };

  const updateDiagnostics = (patch: Partial<PreviewStreamClientDiagnostics>) => {
    diagnostics = {
      ...diagnostics,
      ...patch,
      mediaSourceReadyState: mediaSource.readyState,
    };
    onDiagnosticsChange?.({ ...diagnostics });
  };

  onStatusChange?.("loading");
  updateDiagnostics({});
  videoElement.src = objectUrl;
  videoElement.muted = true;
  videoElement.loop = descriptor.shouldLoop;
  videoElement.playsInline = true;
  videoElement.preload = "auto";

  const bootstrap = async () => {
    await waitForSourceOpen(mediaSource, abortController.signal);

    if (disposed) {
      return;
    }

    sourceBuffer = mediaSource.addSourceBuffer(descriptor.mimeType);
    sourceBuffer.mode = "segments";
    updateDiagnostics({ sourceBufferUpdating: false });

    if (descriptor.deliveryMode === "command-stream") {
      let initLoaded = false;

      while (!disposed && !initLoaded) {
        const initSegment = (await invoke("get_preview_init_segment")) as number[] | null;

        if (initSegment && initSegment.length > 0) {
          updateDiagnostics({ sourceBufferUpdating: true });
          await appendSegment(sourceBuffer, toArrayBuffer(initSegment));
          updateDiagnostics({
            initAppendCount: diagnostics.initAppendCount + 1,
            lastAppendedBytes: initSegment.length,
            lastAppendAtMs: performance.now(),
            sourceBufferUpdating: false,
          });
          onStatusChange?.("ready");
          initLoaded = true;
          break;
        }

        await delay(120, abortController.signal);
      }

      while (!disposed) {
        const nextSegment = (await invoke("take_preview_media_segment")) as PreviewMediaSegmentPayload | null;

        if (!nextSegment) {
          updateDiagnostics({ emptyPollCount: diagnostics.emptyPollCount + 1 });
          await delay(80, abortController.signal);
          continue;
        }

        updateDiagnostics({ sourceBufferUpdating: true });
        await appendSegment(sourceBuffer, toArrayBuffer(nextSegment.bytes));
        updateDiagnostics({
          mediaAppendCount: diagnostics.mediaAppendCount + 1,
          lastAppendedSequenceNumber: nextSegment.sequenceNumber,
          lastAppendedBytes: nextSegment.bytes.length,
          lastAppendAtMs: performance.now(),
          sourceBufferUpdating: false,
        });
        onStatusChange?.("ready");
      }

      return;
    }

    for (const segmentUrl of [descriptor.initSegmentPath, ...descriptor.mediaSegmentPaths]) {
      const response = await fetch(segmentUrl, { signal: abortController.signal });

      if (!response.ok) {
        throw new Error(`Failed to load preview fragment ${segmentUrl}.`);
      }

      const segment = await response.arrayBuffer();

      if (disposed) {
        return;
      }

      updateDiagnostics({ sourceBufferUpdating: true });
      await appendSegment(sourceBuffer, segment);
      updateDiagnostics({
        mediaAppendCount: diagnostics.mediaAppendCount + 1,
        lastAppendedBytes: segment.byteLength,
        lastAppendAtMs: performance.now(),
        sourceBufferUpdating: false,
      });
    }

    if (!disposed && mediaSource.readyState === "open") {
      mediaSource.endOfStream();
    }

    onStatusChange?.("ready");
  };

  void bootstrap().catch((error) => {
    if (disposed || abortController.signal.aborted) {
      return;
    }

    updateDiagnostics({
      appendErrorCount: diagnostics.appendErrorCount + 1,
      sourceBufferUpdating: false,
    });
    onStatusChange?.("error");
    onError?.(formatStreamError(error));
  });

  return () => {
    disposed = true;
    abortController.abort();

    if (sourceBuffer && mediaSource.readyState === "open") {
      try {
        sourceBuffer.abort();
      } catch {
        // Ignore teardown errors from a disposed preview buffer.
      }
    }

    videoElement.pause();
    videoElement.removeAttribute("src");
    videoElement.load();
    updateDiagnostics({ sourceBufferUpdating: false });
    URL.revokeObjectURL(objectUrl);
  };
}