import type { GifWorkerRequest, GifWorkerResponse } from "./gifWorker";

/** The recorder surface the capture flow drives; MediaRecorder already fits it. */
export interface CaptureRecorder {
  readonly state: RecordingState;
  start(timeslice?: number): void;
  pause(): void;
  resume(): void;
  stop(): void;
  addEventListener(type: "stop" | "error", listener: () => void, options?: AddEventListenerOptions): void;
  removeEventListener(type: "stop" | "error", listener: () => void): void;
}

export const GIF_FRAMES_PER_SECOND = 15;
/** GIF frames are scaled so the shorter side fits this... */
const GIF_MAX_SHORT_SIDE = 480;
/** ...and the longer side fits this. */
const GIF_MAX_LONG_SIDE = 960;
/** Stop sampling while this many frames wait to be encoded, so memory stays bounded. */
const MAX_PENDING_FRAMES = 20;
/** Saved GIF data is handed over in pieces this size. */
const CHUNK_BYTES = 4 * 1024 * 1024;

export function gifFrameSize(width: number, height: number) {
  const short = Math.min(width, height);
  const long = Math.max(width, height);
  const scale = Math.min(1, GIF_MAX_SHORT_SIDE / short, GIF_MAX_LONG_SIDE / long);
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

export class GifDataEvent extends Event {
  constructor(readonly data: Blob) {
    super("dataavailable");
  }
}

export class GifProgressEvent extends Event {
  constructor(readonly bytes: number) {
    super("progress");
  }
}

/**
 * Records an animated GIF by sampling a canvas or video on a timer. It mirrors
 * MediaRecorder's state machine and events, so the save flow treats both alike:
 * "dataavailable" fires with the finished GIF, then "stop".
 */
export class GifRecorder extends EventTarget implements CaptureRecorder {
  state: RecordingState = "inactive";
  readonly mimeType = "image/gif";
  private readonly frameCanvas: HTMLCanvasElement;
  private readonly frameContext: CanvasRenderingContext2D;
  private worker: Worker | null = null;
  private timer: number | null = null;
  private pendingFrame: { rgba: ArrayBuffer; capturedAt: number } | null = null;
  private framesInWorker = 0;

  constructor(private readonly source: CanvasImageSource, sourceWidth: number, sourceHeight: number) {
    super();
    const size = gifFrameSize(sourceWidth, sourceHeight);
    this.frameCanvas = document.createElement("canvas");
    this.frameCanvas.width = size.width;
    this.frameCanvas.height = size.height;
    const context = this.frameCanvas.getContext("2d", { willReadFrequently: true });
    if (!context) {
      throw new Error("Could not create the GIF frame canvas.");
    }
    context.imageSmoothingQuality = "high";
    this.frameContext = context;
  }

  start() {
    if (this.state !== "inactive") {
      return;
    }
    this.worker = new Worker(new URL("./gifWorker.ts", import.meta.url), { type: "module" });
    this.worker.onmessage = (event: MessageEvent<GifWorkerResponse>) => this.handleWorkerMessage(event.data);
    this.worker.onerror = () => this.fail();
    this.state = "recording";
    this.captureFrame();
    this.timer = window.setInterval(() => this.captureFrame(), 1000 / GIF_FRAMES_PER_SECOND);
  }

  pause() {
    if (this.state !== "recording") {
      return;
    }
    // The last frame stays on screen only until the pause; nothing paused is kept.
    this.flushPendingFrame(performance.now());
    this.state = "paused";
  }

  resume() {
    if (this.state !== "paused") {
      return;
    }
    this.state = "recording";
    this.captureFrame();
  }

  stop() {
    if (this.state === "inactive") {
      return;
    }
    if (this.state === "recording") {
      this.flushPendingFrame(performance.now());
    }
    this.state = "inactive";
    this.clearTimer();
    this.post({ type: "finish" });
  }

  private captureFrame() {
    if (this.state !== "recording" || this.framesInWorker >= MAX_PENDING_FRAMES) {
      // When the encoder falls behind, the previous frame simply lasts longer.
      return;
    }
    const { width, height } = this.frameCanvas;
    this.frameContext.drawImage(this.source, 0, 0, width, height);
    const rgba = this.frameContext.getImageData(0, 0, width, height).data.buffer as ArrayBuffer;
    const capturedAt = performance.now();
    this.flushPendingFrame(capturedAt);
    this.pendingFrame = { rgba, capturedAt };
  }

  /** Sends the held frame, now that we know how long it stayed on screen. */
  private flushPendingFrame(until: number) {
    const frame = this.pendingFrame;
    if (!frame) {
      return;
    }
    this.pendingFrame = null;
    // GIF delays are stored in hundredths of a second.
    const delayMs = Math.max(20, Math.round((until - frame.capturedAt) / 10) * 10);
    this.framesInWorker += 1;
    this.post(
      { type: "frame", rgba: frame.rgba, width: this.frameCanvas.width, height: this.frameCanvas.height, delayMs },
      [frame.rgba],
    );
  }

  private post(message: GifWorkerRequest, transfer: Transferable[] = []) {
    this.worker?.postMessage(message, transfer);
  }

  private handleWorkerMessage(message: GifWorkerResponse) {
    if (message.type === "progress") {
      this.framesInWorker = Math.max(0, this.framesInWorker - 1);
      this.dispatchEvent(new GifProgressEvent(message.bytes));
      return;
    }
    if (message.type === "error") {
      this.fail();
      return;
    }
    const bytes = new Uint8Array(message.bytes);
    for (let offset = 0; offset < bytes.length; offset += CHUNK_BYTES) {
      this.dispatchEvent(new GifDataEvent(new Blob([bytes.subarray(offset, offset + CHUNK_BYTES)], { type: "image/gif" })));
    }
    this.terminate();
    this.dispatchEvent(new Event("stop"));
  }

  private fail() {
    this.state = "inactive";
    this.clearTimer();
    this.terminate();
    this.dispatchEvent(new Event("error"));
  }

  private clearTimer() {
    if (this.timer !== null) {
      window.clearInterval(this.timer);
      this.timer = null;
    }
  }

  private terminate() {
    this.worker?.terminate();
    this.worker = null;
  }
}
