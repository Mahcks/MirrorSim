export type MockPreviewStreamStatus = "loading" | "ready" | "unsupported" | "error";

import { invoke } from "@tauri-apps/api/core";
import type { PreviewStreamDescriptor } from "./receiverContract";

export type PreviewStreamClientDiagnostics = {
  playbackBackend: "mse" | "webcodecs" | null;
  initAppendCount: number;
  mediaAppendCount: number;
  appendErrorCount: number;
  emptyPollCount: number;
  lastAppendedSequenceNumber: number | null;
  lastAppendedBytes: number;
  lastAppendAtMs: number | null;
  lastKeyframeSequenceNumber: number | null;
  segmentsSinceKeyframe: number;
  emptyBufferedAppendCount: number;
  bufferedRangeCount: number;
  bufferedStart: number;
  bufferedEnd: number;
  lastMediaEvent: string | null;
  lastMediaEventAtMs: number | null;
  lastMediaError: string | null;
  sourceBufferUpdating: boolean;
  mediaSourceReadyState: string;
  decodedOutputCount: number;
  presentedFrameCount: number;
  decoderQueueSize: number;
  decoderClientRecoveryCount: number;
  lastDecodedFrameAtMs: number | null;
  canvasConnected: boolean;
  renderSurfaceConnected: boolean;
  renderSurfaceHealthy: boolean;
  canvasContextLossCount: number;
  decodedFrameFormat: string | null;
  pixelProbeLuma: number | null;
  pixelProbeAverageLuma: number | null;
  pixelProbeDarkRatio: number | null;
  pixelProbeCenterAverageLuma: number | null;
  pixelProbeCenterDarkRatio: number | null;
  pixelProbeBrightRatio: number | null;
  pixelProbeEdgeRatio: number | null;
  pixelProbeSequence: number;
  pixelProbeDecodedOutputCount: number | null;
  lastPixelProbeAtMs: number | null;
};

export const initialPreviewStreamClientDiagnostics: PreviewStreamClientDiagnostics = {
  playbackBackend: null,
  initAppendCount: 0,
  mediaAppendCount: 0,
  appendErrorCount: 0,
  emptyPollCount: 0,
  lastAppendedSequenceNumber: null,
  lastAppendedBytes: 0,
  lastAppendAtMs: null,
  lastKeyframeSequenceNumber: null,
  segmentsSinceKeyframe: 0,
  emptyBufferedAppendCount: 0,
  bufferedRangeCount: 0,
  bufferedStart: 0,
  bufferedEnd: 0,
  lastMediaEvent: null,
  lastMediaEventAtMs: null,
  lastMediaError: null,
  sourceBufferUpdating: false,
  mediaSourceReadyState: "closed",
  decodedOutputCount: 0,
  presentedFrameCount: 0,
  decoderQueueSize: 0,
  decoderClientRecoveryCount: 0,
  lastDecodedFrameAtMs: null,
  canvasConnected: false,
  renderSurfaceConnected: false,
  renderSurfaceHealthy: false,
  canvasContextLossCount: 0,
  decodedFrameFormat: null,
  pixelProbeLuma: null,
  pixelProbeAverageLuma: null,
  pixelProbeDarkRatio: null,
  pixelProbeCenterAverageLuma: null,
  pixelProbeCenterDarkRatio: null,
  pixelProbeBrightRatio: null,
  pixelProbeEdgeRatio: null,
  pixelProbeSequence: 0,
  pixelProbeDecodedOutputCount: null,
  lastPixelProbeAtMs: null,
};

export type PreviewPixelSummary = {
  averageLuma: number;
  darkPixelRatio: number;
  centerAverageLuma: number;
  centerDarkPixelRatio: number;
  brightPixelRatio: number;
  edgePixelRatio: number;
};

export function summarizePreviewPixels(
  pixels: Uint8ClampedArray,
  width = Math.max(1, Math.floor(pixels.length / 4)),
  height = 1,
): PreviewPixelSummary {
  const pixelCount = Math.floor(pixels.length / 4);
  if (pixelCount === 0) {
    return {
      averageLuma: 0,
      darkPixelRatio: 1,
      centerAverageLuma: 0,
      centerDarkPixelRatio: 1,
      brightPixelRatio: 0,
      edgePixelRatio: 0,
    };
  }

  const normalizedWidth = Math.max(1, Math.min(width, pixelCount));
  const normalizedHeight = Math.max(1, Math.min(height, Math.ceil(pixelCount / normalizedWidth)));
  const centerLeft = Math.floor(normalizedWidth * 0.2);
  const centerRight = Math.ceil(normalizedWidth * 0.8);
  const centerTop = Math.floor(normalizedHeight * 0.2);
  const centerBottom = Math.ceil(normalizedHeight * 0.8);
  const lumas = new Float32Array(pixelCount);
  let totalLuma = 0;
  let darkPixelCount = 0;
  let brightPixelCount = 0;
  let centerTotalLuma = 0;
  let centerDarkPixelCount = 0;
  let centerPixelCount = 0;
  for (let index = 0; index < pixelCount * 4; index += 4) {
    // Integer Rec. 709 approximation. A small dark threshold leaves room for
    // compression noise in the black surface iOS supplies for protected video.
    const luma = (54 * pixels[index] + 183 * pixels[index + 1] + 19 * pixels[index + 2]) / 256;
    const pixelIndex = index / 4;
    lumas[pixelIndex] = luma;
    totalLuma += luma;
    if (luma <= 24) {
      darkPixelCount += 1;
    }
    if (luma >= 96) {
      brightPixelCount += 1;
    }

    const x = pixelIndex % normalizedWidth;
    const y = Math.floor(pixelIndex / normalizedWidth);
    if (x >= centerLeft && x < centerRight && y >= centerTop && y < centerBottom) {
      centerPixelCount += 1;
      centerTotalLuma += luma;
      if (luma <= 24) {
        centerDarkPixelCount += 1;
      }
    }
  }

  let edgeCount = 0;
  let edgeComparisonCount = 0;
  for (let pixelIndex = 0; pixelIndex < pixelCount; pixelIndex += 1) {
    const x = pixelIndex % normalizedWidth;
    const y = Math.floor(pixelIndex / normalizedWidth);
    if (x + 1 < normalizedWidth && pixelIndex + 1 < pixelCount) {
      edgeComparisonCount += 1;
      if (Math.abs(lumas[pixelIndex] - lumas[pixelIndex + 1]) >= 32) edgeCount += 1;
    }
    const below = pixelIndex + normalizedWidth;
    if (y + 1 < normalizedHeight && below < pixelCount) {
      edgeComparisonCount += 1;
      if (Math.abs(lumas[pixelIndex] - lumas[below]) >= 32) edgeCount += 1;
    }
  }

  return {
    averageLuma: totalLuma / pixelCount,
    darkPixelRatio: darkPixelCount / pixelCount,
    centerAverageLuma: centerPixelCount > 0 ? centerTotalLuma / centerPixelCount : totalLuma / pixelCount,
    centerDarkPixelRatio: centerPixelCount > 0 ? centerDarkPixelCount / centerPixelCount : darkPixelCount / pixelCount,
    brightPixelRatio: brightPixelCount / pixelCount,
    edgePixelRatio: edgeComparisonCount > 0 ? edgeCount / edgeComparisonCount : 0,
  };
}

type MockPreviewStreamOptions = {
  onStatusChange?: (status: MockPreviewStreamStatus) => void;
  onError?: (message: string) => void;
  onDiagnosticsChange?: (diagnostics: PreviewStreamClientDiagnostics) => void;
};

type PreviewMediaSegmentPayload = {
  sequenceNumber: number;
  firstSampleIndex: number;
  lastSampleIndex: number;
  startsWithKeyframe: boolean;
  decodeTime: number;
  duration: number;
  bytes: ArrayBuffer;
};

type PreviewVideoAccessUnitPayload = {
  sequenceNumber: number;
  keyframe: boolean;
  needsRandomAccess: boolean;
  clientInvalidated: boolean;
  timestamp: number;
  duration: number;
  bytes: ArrayBuffer;
};

type PreviewDecoderPreparation = {
  clientGeneration: number;
  queuedAccessUnits: number;
  needsRandomAccess: boolean;
};

const PREVIEW_SEGMENT_HEADER_BYTES = 25;
const PREVIEW_ACCESS_UNIT_HEADER_BYTES = 17;

type RetainedPreviewFrame = {
  canvas: HTMLCanvasElement;
  width: number;
  height: number;
};

const retainedPreviewFrames = new WeakMap<HTMLVideoElement, RetainedPreviewFrame>();
const persistentPreviewCanvases = new WeakMap<HTMLVideoElement, HTMLCanvasElement>();
const decoderPreparationTails = new WeakMap<HTMLVideoElement, Promise<void>>();

async function serializeDecoderPreparation<T>(
  videoElement: HTMLVideoElement,
  prepare: () => Promise<T>,
): Promise<T> {
  const previous = decoderPreparationTails.get(videoElement) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.catch(() => {}).then(() => gate);
  decoderPreparationTails.set(videoElement, tail);
  await previous.catch(() => {});
  try {
    return await prepare();
  } finally {
    release();
    if (decoderPreparationTails.get(videoElement) === tail) {
      decoderPreparationTails.delete(videoElement);
    }
  }
}

export function getRetainedPreviewFrame(videoElement: HTMLVideoElement): RetainedPreviewFrame | null {
  return retainedPreviewFrames.get(videoElement) ?? null;
}

export function retainPreviewFrame(videoElement: HTMLVideoElement, canvas: HTMLCanvasElement) {
  retainedPreviewFrames.set(videoElement, {
    canvas,
    width: canvas.width,
    height: canvas.height,
  });
}

export function clearRetainedPreviewFrame(videoElement: HTMLVideoElement) {
  retainedPreviewFrames.delete(videoElement);
  const canvas = persistentPreviewCanvases.get(videoElement);
  canvas?.remove();
  persistentPreviewCanvases.delete(videoElement);
}

export function mountPreviewSurface(videoElement: HTMLVideoElement, host: HTMLDivElement) {
  if (videoElement.parentElement !== host) {
    host.appendChild(videoElement);
  }
  const canvas = persistentPreviewCanvases.get(videoElement);
  if (canvas && canvas.parentElement !== host) {
    host.appendChild(canvas);
  }
}

export function decodePreviewMediaSegmentResponse(response: ArrayBuffer): PreviewMediaSegmentPayload | null {
  if (response.byteLength === 0) {
    return null;
  }
  if (response.byteLength < PREVIEW_SEGMENT_HEADER_BYTES) {
    throw new Error("The preview media response was shorter than its binary header.");
  }

  const view = new DataView(response);
  return {
    sequenceNumber: view.getUint32(0, true),
    firstSampleIndex: view.getUint32(4, true),
    lastSampleIndex: view.getUint32(8, true),
    startsWithKeyframe: (view.getUint8(12) & 1) !== 0,
    decodeTime: Number(view.getBigUint64(13, true)),
    duration: view.getUint32(21, true),
    bytes: response.slice(PREVIEW_SEGMENT_HEADER_BYTES),
  };
}

export function decodePreviewVideoAccessUnitResponse(response: ArrayBuffer): PreviewVideoAccessUnitPayload | null {
  if (response.byteLength === 0) {
    return null;
  }
  if (response.byteLength < PREVIEW_ACCESS_UNIT_HEADER_BYTES) {
    throw new Error("The preview access-unit response was shorter than its binary header.");
  }

  const view = new DataView(response);
  return {
    sequenceNumber: view.getUint32(0, true),
    keyframe: (view.getUint8(4) & 1) !== 0,
    needsRandomAccess: (view.getUint8(4) & 2) !== 0,
    clientInvalidated: (view.getUint8(4) & 4) !== 0,
    timestamp: Number(view.getBigUint64(5, true)),
    duration: view.getUint32(13, true),
    bytes: response.slice(PREVIEW_ACCESS_UNIT_HEADER_BYTES),
  };
}

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

function hexToArrayBuffer(hex: string) {
  if (hex.length === 0 || hex.length % 2 !== 0 || !/^[0-9a-f]+$/i.test(hex)) {
    throw new Error("The live decoder configuration is missing or malformed.");
  }
  const bytes = new Uint8Array(hex.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    const byte = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
    if (!Number.isFinite(byte)) {
      throw new Error("The live decoder configuration contains invalid hexadecimal data.");
    }
    bytes[index] = byte;
  }
  return bytes.buffer;
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

  if (descriptor.deliveryMode === "command-stream" && descriptor.decoderConfigHex.length === 0) {
    onStatusChange?.("loading");
    onDiagnosticsChange?.({ ...initialPreviewStreamClientDiagnostics });
    return () => {};
  }

  const webCodecsGlobal = globalThis as typeof globalThis & {
    VideoDecoder?: typeof VideoDecoder;
    EncodedVideoChunk?: typeof EncodedVideoChunk;
  };
  const canUseWebCodecs = descriptor.deliveryMode === "command-stream"
    && descriptor.decoderConfigHex.length > 0
    && descriptor.codedWidth > 0
    && descriptor.codedHeight > 0
    && typeof webCodecsGlobal.VideoDecoder === "function"
    && typeof webCodecsGlobal.EncodedVideoChunk === "function"
    && typeof document !== "undefined";
  if (canUseWebCodecs) {
    return attachWebCodecsPreviewStream(videoElement, descriptor, options);
  }

  if (typeof window === "undefined" || !("MediaSource" in window) || !MediaSource.isTypeSupported(descriptor.mimeType)) {
    onStatusChange?.("unsupported");
    return () => {};
  }

  const abortController = new AbortController();
  const mediaSource = new MediaSource();
  const objectUrl = URL.createObjectURL(mediaSource);
  let disposed = false;
  let sourceBuffer: SourceBuffer | null = null;
  let diagnostics: PreviewStreamClientDiagnostics = {
    ...initialPreviewStreamClientDiagnostics,
    playbackBackend: "mse" as const,
    mediaSourceReadyState: mediaSource.readyState,
    renderSurfaceConnected: videoElement.isConnected,
    renderSurfaceHealthy: true,
  };
  const probeCanvas = document.createElement("canvas");
  probeCanvas.width = 48;
  probeCanvas.height = 27;
  const probeContext = probeCanvas.getContext("2d", { willReadFrequently: true });
  let videoFrameCallbackId: number | null = null;
  let lastVideoProbeAtMs = 0;

  const updateDiagnostics = (patch: Partial<PreviewStreamClientDiagnostics>) => {
    diagnostics = {
      ...diagnostics,
      ...patch,
      mediaSourceReadyState: mediaSource.readyState,
    };
    onDiagnosticsChange?.({ ...diagnostics });
  };

  const videoEvents = ["canplay", "emptied", "error", "playing", "stalled", "suspend", "waiting"] as const;
  const recordVideoEvent = (event: Event) => {
    if (disposed) {
      return;
    }
    const mediaError = videoElement.error;
    updateDiagnostics({
      lastMediaEvent: `video:${event.type}`,
      lastMediaEventAtMs: performance.now(),
      renderSurfaceConnected: videoElement.isConnected,
      renderSurfaceHealthy: event.type !== "error",
      lastMediaError: mediaError
        ? `code ${mediaError.code}${mediaError.message ? `: ${mediaError.message}` : ""}`
        : diagnostics.lastMediaError,
    });
  };
  const recordMediaSourceEvent = (event: Event) => {
    if (!disposed) {
      updateDiagnostics({
        lastMediaEvent: `media-source:${event.type}`,
        lastMediaEventAtMs: performance.now(),
      });
    }
  };
  videoEvents.forEach((eventName) => videoElement.addEventListener(eventName, recordVideoEvent));
  mediaSource.addEventListener("sourceended", recordMediaSourceEvent);
  mediaSource.addEventListener("sourceclose", recordMediaSourceEvent);

  const observeVideoFrame: VideoFrameRequestCallback = (_now, metadata) => {
    if (disposed) return;
    const observedAtMs = performance.now();
    if (observedAtMs - lastVideoProbeAtMs < 1_000) {
      videoFrameCallbackId = videoElement.requestVideoFrameCallback(observeVideoFrame);
      return;
    }
    lastVideoProbeAtMs = observedAtMs;
    const decodedOutputCount = Math.max(
      diagnostics.decodedOutputCount + 1,
      metadata.presentedFrames,
    );
    const patch: Partial<PreviewStreamClientDiagnostics> = {
      decodedOutputCount,
      presentedFrameCount: Math.max(diagnostics.presentedFrameCount + 1, metadata.presentedFrames),
      lastDecodedFrameAtMs: observedAtMs,
      renderSurfaceConnected: videoElement.isConnected,
      renderSurfaceHealthy: videoElement.error === null,
    };
    if (probeContext && videoElement.videoWidth > 0 && videoElement.videoHeight > 0) {
      try {
        probeContext.drawImage(videoElement, 0, 0, probeCanvas.width, probeCanvas.height);
        const pixels = probeContext.getImageData(0, 0, probeCanvas.width, probeCanvas.height).data;
        const summary = summarizePreviewPixels(pixels, probeCanvas.width, probeCanvas.height);
        patch.pixelProbeAverageLuma = summary.averageLuma;
        patch.pixelProbeDarkRatio = summary.darkPixelRatio;
        patch.pixelProbeCenterAverageLuma = summary.centerAverageLuma;
        patch.pixelProbeCenterDarkRatio = summary.centerDarkPixelRatio;
        patch.pixelProbeBrightRatio = summary.brightPixelRatio;
        patch.pixelProbeEdgeRatio = summary.edgePixelRatio;
        patch.pixelProbeSequence = diagnostics.pixelProbeSequence + 1;
        patch.pixelProbeDecodedOutputCount = decodedOutputCount;
        patch.lastPixelProbeAtMs = observedAtMs;
      } catch (error) {
        console.warn("[MirrorSim preview] MSE pixel probe failed", error);
      }
    }
    updateDiagnostics(patch);
    videoFrameCallbackId = videoElement.requestVideoFrameCallback(observeVideoFrame);
  };
  if (typeof videoElement.requestVideoFrameCallback === "function") {
    videoFrameCallbackId = videoElement.requestVideoFrameCallback(observeVideoFrame);
  }

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
      const clientGeneration = await invoke<number>("prepare_preview_media_stream");
      if (disposed) {
        return;
      }
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
          initLoaded = true;
          break;
        }

        await delay(120, abortController.signal);
      }

      while (!disposed) {
        const response = await invoke<ArrayBuffer>("take_preview_media_segment", { clientGeneration });
        const nextSegment = decodePreviewMediaSegmentResponse(response);

        if (disposed) {
          return;
        }

        if (!nextSegment) {
          updateDiagnostics({ emptyPollCount: diagnostics.emptyPollCount + 1 });
          await delay(80, abortController.signal);
          continue;
        }

        updateDiagnostics({ sourceBufferUpdating: true });
        await appendSegment(sourceBuffer, nextSegment.bytes);
        // Do not remove an arbitrary time range from a live H.264 SourceBuffer. MSE
        // extends removals through the next random-access point; an iPhone can leave
        // a long gap between IDRs, which previously erased the whole decodable GOP.
        // Chromium's quota eviction is keyframe-aware and is safer until we have a
        // later random-access point at which to perform explicit eviction.
        const bufferedRangeCount = sourceBuffer.buffered.length;
        const bufferedStart = bufferedRangeCount > 0 ? sourceBuffer.buffered.start(0) : 0;
        const bufferedEnd = bufferedRangeCount > 0
          ? sourceBuffer.buffered.end(bufferedRangeCount - 1)
          : 0;
        updateDiagnostics({
          mediaAppendCount: diagnostics.mediaAppendCount + 1,
          lastAppendedSequenceNumber: nextSegment.sequenceNumber,
          lastAppendedBytes: nextSegment.bytes.byteLength,
          lastAppendAtMs: performance.now(),
          lastKeyframeSequenceNumber: nextSegment.startsWithKeyframe
            ? nextSegment.sequenceNumber
            : diagnostics.lastKeyframeSequenceNumber,
          segmentsSinceKeyframe: nextSegment.startsWithKeyframe
            ? 0
            : diagnostics.segmentsSinceKeyframe + 1,
          emptyBufferedAppendCount: bufferedRangeCount === 0
            ? diagnostics.emptyBufferedAppendCount + 1
            : diagnostics.emptyBufferedAppendCount,
          bufferedRangeCount,
          bufferedStart,
          bufferedEnd,
          sourceBufferUpdating: false,
        });
        if (bufferedRangeCount > 0) {
          onStatusChange?.("ready");
        }
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
    videoEvents.forEach((eventName) => videoElement.removeEventListener(eventName, recordVideoEvent));
    mediaSource.removeEventListener("sourceended", recordMediaSourceEvent);
    mediaSource.removeEventListener("sourceclose", recordMediaSourceEvent);
    if (videoFrameCallbackId !== null && typeof videoElement.cancelVideoFrameCallback === "function") {
      videoElement.cancelVideoFrameCallback(videoFrameCallbackId);
    }

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

function invokeWithTimeout<T>(
  command: string,
  args: Record<string, unknown> | undefined,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) {
        return;
      }
      settled = true;
      window.clearTimeout(timeoutId);
      signal.removeEventListener("abort", handleAbort);
      callback();
    };
    const handleAbort = () => finish(() => reject(new DOMException("The preview command was aborted.", "AbortError")));
    const timeoutId = window.setTimeout(() => {
      finish(() => reject(new Error(`The ${command} command did not respond within ${timeoutMs} ms.`)));
    }, timeoutMs);

    signal.addEventListener("abort", handleAbort, { once: true });
    if (signal.aborted) {
      handleAbort();
      return;
    }
    void invoke<T>(command, args).then(
      (value) => finish(() => resolve(value)),
      (error) => finish(() => reject(error)),
    );
  });
}

function attachWebCodecsPreviewStream(
  videoElement: HTMLVideoElement,
  descriptor: PreviewStreamDescriptor,
  options: MockPreviewStreamOptions,
) {
  const { onStatusChange, onError, onDiagnosticsChange } = options;
  const webCodecsGlobal = globalThis as typeof globalThis & {
    VideoDecoder?: typeof VideoDecoder;
    EncodedVideoChunk?: typeof EncodedVideoChunk;
  };
  const VideoDecoderCtor = webCodecsGlobal.VideoDecoder;
  const EncodedVideoChunkCtor = webCodecsGlobal.EncodedVideoChunk;
  if (!VideoDecoderCtor || !EncodedVideoChunkCtor) {
    onStatusChange?.("unsupported");
    return () => {};
  }
  const abortController = new AbortController();
  let canvas = persistentPreviewCanvases.get(videoElement);
  if (!canvas) {
    canvas = document.createElement("canvas");
    persistentPreviewCanvases.set(videoElement, canvas);
  }
  canvas.width = descriptor.codedWidth;
  canvas.height = descriptor.codedHeight;
  canvas.className = "absolute inset-0 h-full w-full object-contain";
  canvas.setAttribute("aria-hidden", "true");
  const context = canvas.getContext("2d", { alpha: false });
  if (!context) {
    onStatusChange?.("error");
    onError?.("The live preview could not create its video rendering surface.");
    return () => {};
  }
  const probeCanvas = document.createElement("canvas");
  // A denser probe keeps thin playback controls from being smeared across a
  // coarse sample and making a predominantly black surface look mid-gray.
  probeCanvas.width = 48;
  probeCanvas.height = 27;
  const probeContext = probeCanvas.getContext("2d", { willReadFrequently: true });

  let disposed = false;
  let decoder: VideoDecoder | null = null;
  let decoderConfigured = false;
  let waitingForKeyframe = true;
  let lastSampleIndex: number | null = null;
  let firstFrameDrawn = false;
  let readyReported = false;
  let terminalFailure = false;
  let diagnostics: PreviewStreamClientDiagnostics = {
    ...initialPreviewStreamClientDiagnostics,
    playbackBackend: "webcodecs",
    mediaSourceReadyState: "not-used",
  };
  let lastDiagnosticsEmitAt = 0;
  let lastPixelProbeAt = 0;

  const publishDiagnostics = (force = false) => {
    const now = performance.now();
    if (!force && now - lastDiagnosticsEmitAt < 200) {
      return;
    }
    lastDiagnosticsEmitAt = now;
    onDiagnosticsChange?.({ ...diagnostics });
  };
  const patchDiagnostics = (patch: Partial<PreviewStreamClientDiagnostics>, force = false) => {
    diagnostics = { ...diagnostics, ...patch };
    publishDiagnostics(force);
  };
  const failTerminal = (message: string, event = "webcodecs:error") => {
    if (disposed || terminalFailure) {
      return;
    }
    terminalFailure = true;
    abortController.abort();
    patchDiagnostics({
      appendErrorCount: diagnostics.appendErrorCount + 1,
      lastMediaEvent: event,
      lastMediaEventAtMs: performance.now(),
      lastMediaError: message,
    }, true);
    console.error("[MirrorSim preview] terminal WebCodecs failure", {
      message,
      event,
      streamId: descriptor.streamId,
      configGeneration: descriptor.configGeneration,
      diagnostics,
    });
    onStatusChange?.("error");
    onError?.(message);
    if (decoder && decoder.state !== "closed") {
      decoder.close();
    }
  };

  const decoderConfig: VideoDecoderConfig = {
    codec: descriptor.codec,
    codedWidth: descriptor.codedWidth,
    codedHeight: descriptor.codedHeight,
    description: hexToArrayBuffer(descriptor.decoderConfigHex),
    hardwareAcceleration: "prefer-hardware",
    optimizeForLatency: true,
  };

  videoElement.pause();
  videoElement.removeAttribute("src");
  videoElement.srcObject = null;
  videoElement.style.opacity = "0";
  videoElement.muted = true;
  videoElement.playsInline = true;
  videoElement.preload = "auto";
  const videoEvents = ["canplay", "emptied", "error", "loadeddata", "playing", "stalled", "waiting"] as const;
  const recordVideoEvent = (event: Event) => {
    if (disposed) {
      return;
    }
    const mediaError = videoElement.error;
    patchDiagnostics({
      lastMediaEvent: `video:${event.type}`,
      lastMediaEventAtMs: performance.now(),
      lastMediaError: mediaError
        ? `code ${mediaError.code}${mediaError.message ? `: ${mediaError.message}` : ""}`
        : diagnostics.lastMediaError,
    }, event.type === "error");
  };
  videoEvents.forEach((eventName) => videoElement.addEventListener(eventName, recordVideoEvent));
  const recordContextLost = (event: Event) => {
    event.preventDefault();
    patchDiagnostics({
      canvasConnected: canvas.isConnected,
      renderSurfaceConnected: canvas.isConnected,
      renderSurfaceHealthy: false,
      canvasContextLossCount: diagnostics.canvasContextLossCount + 1,
      lastMediaEvent: "canvas:context-lost",
      lastMediaEventAtMs: performance.now(),
      lastMediaError: "The preview canvas rendering context was lost.",
    }, true);
  };
  const recordContextRestored = () => {
    patchDiagnostics({
      canvasConnected: canvas.isConnected,
      renderSurfaceConnected: canvas.isConnected,
      renderSurfaceHealthy: true,
      lastMediaEvent: "canvas:context-restored",
      lastMediaEventAtMs: performance.now(),
      lastMediaError: null,
    }, true);
  };
  canvas.addEventListener("contextlost", recordContextLost);
  canvas.addEventListener("contextrestored", recordContextRestored);
  const mountCanvasBesideVideo = () => {
    const host = videoElement.parentElement;
    if (host && canvas.parentElement !== host) {
      host.appendChild(canvas);
    }
  };
  mountCanvasBesideVideo();
  onStatusChange?.("loading");
  patchDiagnostics({ lastMediaEvent: "webcodecs:configuring", lastMediaEventAtMs: performance.now() }, true);

  const bootstrap = async () => {
    const support = await VideoDecoderCtor.isConfigSupported(decoderConfig);
    if (!support.supported) {
      throw new Error(`The installed WebView cannot decode ${descriptor.codec} live video.`);
    }
    if (disposed) {
      return;
    }

    const activeDecoder = new VideoDecoderCtor({
      output: (frame) => {
        try {
          if (disposed || terminalFailure) {
            return;
          }
          const width = frame.displayWidth || frame.codedWidth || descriptor.codedWidth;
          const height = frame.displayHeight || frame.codedHeight || descriptor.codedHeight;
          if (canvas.width !== width || canvas.height !== height) {
            canvas.width = width;
            canvas.height = height;
          }
          context.drawImage(frame as unknown as CanvasImageSource, 0, 0, canvas.width, canvas.height);
          mountCanvasBesideVideo();
          retainPreviewFrame(videoElement, canvas);
          const now = performance.now();
          let pixelProbeLuma = diagnostics.pixelProbeLuma;
          let pixelProbeAverageLuma = diagnostics.pixelProbeAverageLuma;
          let pixelProbeDarkRatio = diagnostics.pixelProbeDarkRatio;
          let pixelProbeCenterAverageLuma = diagnostics.pixelProbeCenterAverageLuma;
          let pixelProbeCenterDarkRatio = diagnostics.pixelProbeCenterDarkRatio;
          let pixelProbeBrightRatio = diagnostics.pixelProbeBrightRatio;
          let pixelProbeEdgeRatio = diagnostics.pixelProbeEdgeRatio;
          let pixelProbeSequence = diagnostics.pixelProbeSequence;
          let pixelProbeDecodedOutputCount = diagnostics.pixelProbeDecodedOutputCount;
          let lastPixelProbeAtMs = diagnostics.lastPixelProbeAtMs;
          if (probeContext && now - lastPixelProbeAt >= 1_000) {
            try {
              probeContext.drawImage(canvas, 0, 0, probeCanvas.width, probeCanvas.height);
              const pixels = probeContext.getImageData(0, 0, probeCanvas.width, probeCanvas.height).data;
              let luma = 0;
              for (let index = 0; index < pixels.length; index += 4) {
                luma += pixels[index] + pixels[index + 1] + pixels[index + 2];
              }
              const pixelSummary = summarizePreviewPixels(pixels, probeCanvas.width, probeCanvas.height);
              pixelProbeLuma = luma;
              pixelProbeAverageLuma = pixelSummary.averageLuma;
              pixelProbeDarkRatio = pixelSummary.darkPixelRatio;
              pixelProbeCenterAverageLuma = pixelSummary.centerAverageLuma;
              pixelProbeCenterDarkRatio = pixelSummary.centerDarkPixelRatio;
              pixelProbeBrightRatio = pixelSummary.brightPixelRatio;
              pixelProbeEdgeRatio = pixelSummary.edgePixelRatio;
              pixelProbeSequence += 1;
              pixelProbeDecodedOutputCount = diagnostics.decodedOutputCount + 1;
              lastPixelProbeAtMs = now;
              lastPixelProbeAt = now;
            } catch (error) {
              console.warn("[MirrorSim preview] pixel probe failed", error);
            }
          }
          const isFirstFrame = !firstFrameDrawn;
          firstFrameDrawn = true;
          patchDiagnostics({
            decodedOutputCount: diagnostics.decodedOutputCount + 1,
            // The decoded canvas is the visible surface, so a successful draw is
            // also a presented frame. Recording captures this canvas lazily.
            presentedFrameCount: diagnostics.presentedFrameCount + 1,
            decoderQueueSize: activeDecoder.decodeQueueSize,
            canvasConnected: canvas.isConnected,
            renderSurfaceConnected: canvas.isConnected,
            renderSurfaceHealthy: true,
            lastDecodedFrameAtMs: now,
            decodedFrameFormat: frame.format ?? null,
            pixelProbeLuma,
            pixelProbeAverageLuma,
            pixelProbeDarkRatio,
            pixelProbeCenterAverageLuma,
            pixelProbeCenterDarkRatio,
            pixelProbeBrightRatio,
            pixelProbeEdgeRatio,
            pixelProbeSequence,
            pixelProbeDecodedOutputCount,
            lastPixelProbeAtMs,
            lastMediaEvent: "webcodecs:frame",
            lastMediaEventAtMs: performance.now(),
            lastMediaError: null,
          });
          if (isFirstFrame) {
            readyReported = true;
            onStatusChange?.("ready");
          }
          if (!readyReported) {
            readyReported = true;
            onStatusChange?.("ready");
          }
        } catch (error) {
          failTerminal(
            `The live preview could not present a decoded frame: ${formatStreamError(error)}`,
            "webcodecs:render-error",
          );
        } finally {
          frame.close();
        }
      },
      error: (error) => {
        failTerminal(`The live video decoder stopped: ${formatStreamError(error)}`);
      },
    });
    decoder = activeDecoder;
    activeDecoder.configure(decoderConfig);
    decoderConfigured = true;
    let preparation = await serializeDecoderPreparation(videoElement, async () => {
      if (disposed) {
        throw new DOMException("The preview attachment was replaced.", "AbortError");
      }
      return invokeWithTimeout<PreviewDecoderPreparation>(
        "prepare_preview_decoder_stream",
        undefined,
        5_000,
        abortController.signal,
      );
    });
    if (disposed) {
      return;
    }
    if (preparation.needsRandomAccess) {
      throw new Error(
        "The live decoder needs a fresh keyframe. Turn Screen Mirroring off and back on on the iPhone.",
      );
    }
    let clientGeneration = preparation.clientGeneration;
    let invalidationRecoveryCount = 0;
    let presentationStartedAt = performance.now();
    let decoderBackpressureStartedAt: number | null = null;

    while (!disposed && activeDecoder.state !== "closed") {
      if (!firstFrameDrawn && diagnostics.mediaAppendCount > 0 && performance.now() - presentationStartedAt > 5_000) {
        throw new Error("The live decoder received video but could not produce a frame. Reconnect Screen Mirroring and try again.");
      }
      if (activeDecoder.decodeQueueSize > 8) {
        const now = performance.now();
        if (document.visibilityState === "hidden") {
          decoderBackpressureStartedAt = null;
        } else if (decoderBackpressureStartedAt === null) {
          decoderBackpressureStartedAt = now;
        } else if (now - decoderBackpressureStartedAt > 3_000) {
          throw new Error(
            "The live decoder stopped draining its video queue. Reconnect Screen Mirroring to resume safely.",
          );
        }
        patchDiagnostics({ decoderQueueSize: activeDecoder.decodeQueueSize });
        await delay(4, abortController.signal);
        continue;
      }
      decoderBackpressureStartedAt = null;

      const response = await invokeWithTimeout<ArrayBuffer>(
        "take_preview_video_access_unit",
        { clientGeneration },
        2_000,
        abortController.signal,
      );
      const accessUnit = decodePreviewVideoAccessUnitResponse(response);
      if (disposed) {
        return;
      }
      if (!accessUnit) {
        patchDiagnostics({ emptyPollCount: diagnostics.emptyPollCount + 1 });
        await delay(16, abortController.signal);
        continue;
      }
      if (accessUnit.clientInvalidated) {
        if (invalidationRecoveryCount >= 2) {
          throw new Error(
            "The live preview was repeatedly replaced by another decoder client. Retry the preview once.",
          );
        }
        invalidationRecoveryCount += 1;
        preparation = await serializeDecoderPreparation(videoElement, async () => {
          if (disposed) {
            throw new DOMException("The preview attachment was replaced.", "AbortError");
          }
          return invokeWithTimeout<PreviewDecoderPreparation>(
            "prepare_preview_decoder_stream",
            undefined,
            5_000,
            abortController.signal,
          );
        });
        if (disposed) {
          return;
        }
        if (preparation.needsRandomAccess) {
          throw new Error(
            "The live preview changed after its recovery frame expired. Turn Screen Mirroring off and back on on the iPhone.",
          );
        }
        clientGeneration = preparation.clientGeneration;
        activeDecoder.reset();
        activeDecoder.configure(decoderConfig);
        waitingForKeyframe = true;
        lastSampleIndex = null;
        presentationStartedAt = performance.now();
        patchDiagnostics({
          decoderClientRecoveryCount: diagnostics.decoderClientRecoveryCount + 1,
          lastMediaEvent: "webcodecs:client-reacquired",
          lastMediaEventAtMs: performance.now(),
          lastMediaError: null,
        }, true);
        continue;
      }
      if (accessUnit.needsRandomAccess) {
        throw new Error(
          "The live decoder lost video continuity. Turn Screen Mirroring off and back on on the iPhone.",
        );
      }

      const discontinuity = lastSampleIndex !== null && accessUnit.sequenceNumber !== lastSampleIndex + 1;
      lastSampleIndex = accessUnit.sequenceNumber;
      if (discontinuity) {
        if (!accessUnit.keyframe) {
          throw new Error(
            "The live decoder lost video continuity before a new keyframe arrived. Turn Screen Mirroring off and back on on the iPhone.",
          );
        }
        activeDecoder.reset();
        activeDecoder.configure(decoderConfig);
        waitingForKeyframe = true;
        readyReported = false;
        presentationStartedAt = performance.now();
        patchDiagnostics({
          lastMediaEvent: "webcodecs:continuity-gap",
          lastMediaEventAtMs: performance.now(),
          lastMediaError: "Video continuity was interrupted; restarting from the new keyframe.",
        }, true);
        onStatusChange?.("loading");
      }
      if (waitingForKeyframe && !accessUnit.keyframe) {
        continue;
      }
      if (accessUnit.keyframe) {
        waitingForKeyframe = false;
      }

      activeDecoder.decode(new EncodedVideoChunkCtor({
        type: accessUnit.keyframe ? "key" : "delta",
        timestamp: accessUnit.timestamp,
        duration: accessUnit.duration,
        data: accessUnit.bytes,
      }));
      patchDiagnostics({
        mediaAppendCount: diagnostics.mediaAppendCount + 1,
        lastAppendedSequenceNumber: accessUnit.sequenceNumber,
        lastAppendedBytes: accessUnit.bytes.byteLength,
        lastAppendAtMs: performance.now(),
        lastKeyframeSequenceNumber: accessUnit.keyframe
          ? accessUnit.sequenceNumber
          : diagnostics.lastKeyframeSequenceNumber,
        segmentsSinceKeyframe: accessUnit.keyframe ? 0 : diagnostics.segmentsSinceKeyframe + 1,
        decoderQueueSize: activeDecoder.decodeQueueSize,
        lastMediaError: null,
      });
    }
  };

  void bootstrap().catch((error) => {
    if (disposed || terminalFailure) {
      return;
    }
    failTerminal(formatStreamError(error));
  });

  return () => {
    disposed = true;
    abortController.abort();
    if (decoder && decoder.state !== "closed") {
      decoder.close();
    }
    videoEvents.forEach((eventName) => videoElement.removeEventListener(eventName, recordVideoEvent));
    canvas.removeEventListener("contextlost", recordContextLost);
    canvas.removeEventListener("contextrestored", recordContextRestored);
    // The canvas is the visible surface and also the last known-good capture
    // frame. Keep it mounted across decoder retries and React host remounts;
    // the session teardown removes it via clearRetainedPreviewFrame().
    videoElement.pause();
    videoElement.style.removeProperty("opacity");
    if (!firstFrameDrawn && decoderConfigured) {
      patchDiagnostics({ lastMediaEvent: "webcodecs:closed", lastMediaEventAtMs: performance.now() }, true);
    }
  };
}
