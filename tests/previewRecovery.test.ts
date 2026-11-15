import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { attachMockPreviewStream, clearRetainedPreviewFrame } from "../src/mockPreviewStream";
import type { PreviewStreamDescriptor } from "../src/receiverContract";

const descriptor: PreviewStreamDescriptor = {
  streamId: "fault-probe", configGeneration: 1, transport: "airplayserver",
  deliveryMode: "command-stream", mimeType: 'video/mp4; codecs="avc1.640028"',
  codec: "avc1.640028", codedWidth: 16, codedHeight: 16, decoderConfigHex: "010203",
  initSegmentPath: "", mediaSegmentPaths: [], shouldLoop: false,
};
const replaced = new Map<string, PropertyDescriptor | undefined>();
let dispose: (() => void) | undefined;
let video: HTMLVideoElement | undefined;

function replace(name: string, value: unknown) {
  replaced.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
  Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
}

afterEach(async () => {
  dispose?.();
  if (video) clearRetainedPreviewFrame(video);
  await Promise.resolve();
  clearMocks();
  for (const [name, property] of replaced) {
    if (property) Object.defineProperty(globalThis, name, property);
    else Reflect.deleteProperty(globalThis, name);
  }
  replaced.clear();
  dispose = undefined;
  video = undefined;
});

function unit(sequence: number, flags: number) {
  const bytes = new Uint8Array(flags & 6 ? 17 : 18);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, sequence, true);
  view.setUint8(4, flags);
  view.setBigUint64(5, BigInt(sequence) * 16667n, true);
  view.setUint32(13, 16667, true);
  return bytes.buffer;
}

function environment() {
  const decoded: number[] = [];
  class Decoder {
    static async isConfigSupported() { return { supported: true }; }
    state = "unconfigured";
    decodeQueueSize = 0;
    constructor(private callbacks: { output: (frame: unknown) => void }) {}
    configure() { this.state = "configured"; }
    reset() { this.state = "unconfigured"; }
    close() { this.state = "closed"; }
    decode(chunk: { timestamp: number }) {
      decoded.push(chunk.timestamp);
      this.callbacks.output({ displayWidth: 16, displayHeight: 16, close() {} });
    }
  }
  replace("window", { setTimeout, clearTimeout, crypto });
  replace("document", {
    visibilityState: "visible",
    createElement: () => Object.assign(new EventTarget(), {
      width: 16, height: 16, isConnected: true, setAttribute() {}, remove() {},
      getContext: () => ({ drawImage() {}, getImageData: () => ({ data: new Uint8ClampedArray(48 * 27 * 4) }) }),
    }),
  });
  replace("VideoDecoder", Decoder);
  replace("EncodedVideoChunk", class { constructor(init: object) { Object.assign(this, init); } });
  video = Object.assign(new EventTarget(), {
    pause() {}, removeAttribute() {}, style: { removeProperty() {} }, parentElement: null,
  }) as unknown as HTMLVideoElement;
  return decoded;
}

describe("preview recovery after interrupted delivery", () => {
  for (const initiallyMissing of [false, true]) {
    test(initiallyMissing ? "waits for an IDR when the bootstrap cache expired" : "resumes after a queue overflow when a later IDR arrives", async () => {
      const decoded = environment();
      const errors: string[] = [];
      const responses = initiallyMissing
        ? [new ArrayBuffer(0), unit(902, 1)]
        : [unit(0, 1), unit(0, 2), unit(0, 2), unit(901, 0), unit(902, 1)];
      mockIPC((command) => {
        if (command === "prepare_preview_decoder_stream") {
          return { clientGeneration: 1, queuedAccessUnits: initiallyMissing ? 0 : 1, needsRandomAccess: initiallyMissing };
        }
        if (command === "take_preview_video_access_unit") return responses.shift() ?? new ArrayBuffer(0);
        throw new Error(`unexpected command: ${command}`);
      });
      dispose = attachMockPreviewStream(video!, descriptor, { onError: (message) => errors.push(message) });
      const deadline = performance.now() + 500;
      while (!decoded.includes(902 * 16667) && errors.length === 0 && performance.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      expect(errors).toEqual([]);
      expect(decoded).toEqual(initiallyMissing ? [902 * 16667] : [0, 902 * 16667]);
    });
  }

  test("a delta-frame sequence gap also waits for the next IDR", async () => {
    const decoded = environment();
    const errors: string[] = [];
    const responses = [unit(0, 1), unit(80, 0), unit(81, 0), unit(82, 1)];
    mockIPC((command) => command === "prepare_preview_decoder_stream"
      ? { clientGeneration: 1, queuedAccessUnits: 1, needsRandomAccess: false }
      : responses.shift() ?? new ArrayBuffer(0));
    dispose = attachMockPreviewStream(video!, descriptor, { onError: (message) => errors.push(message) });
    const deadline = performance.now() + 500;
    while (!decoded.includes(82 * 16667) && errors.length === 0 && performance.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(errors).toEqual([]);
    expect(decoded).toEqual([0, 82 * 16667]);
  });

  test("repeated loss signals cannot extend the recovery timeout forever", async () => {
    environment();
    const errors: string[] = [];
    let now = 100;
    const clock = spyOn(performance, "now").mockImplementation(() => now);
    const consoleError = spyOn(console, "error").mockImplementation(() => {});
    let polls = 0;
    try {
      mockIPC((command) => {
        if (command === "prepare_preview_decoder_stream") {
          return { clientGeneration: 1, queuedAccessUnits: 0, needsRandomAccess: true };
        }
        polls += 1;
        now += 16_000;
        return unit(0, 2);
      });
      dispose = attachMockPreviewStream(video!, descriptor, { onError: (message) => errors.push(message) });
      for (let attempt = 0; attempt < 50 && errors.length === 0; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      expect(errors).toHaveLength(1);
      expect(errors[0]).toContain("No recovery keyframe arrived within 30 seconds");
      expect(polls).toBe(2);
    } finally {
      clock.mockRestore();
      consoleError.mockRestore();
    }
  });

  test("disposing a waiting preview cancels polling without reconnecting", async () => {
    const decoded = environment();
    const errors: string[] = [];
    let polls = 0;
    mockIPC((command) => {
      if (command === "prepare_preview_decoder_stream") {
        return { clientGeneration: 1, queuedAccessUnits: 0, needsRandomAccess: true };
      }
      polls += 1;
      return unit(0, 2);
    });
    dispose = attachMockPreviewStream(video!, descriptor, { onError: (message) => errors.push(message) });
    for (let attempt = 0; attempt < 50 && polls === 0; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(polls).toBeGreaterThan(0);
    dispose();
    dispose = undefined;
    const pollsBeforeDispose = polls;
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(polls).toBe(pollsBeforeDispose);
    expect(decoded).toEqual([]);
    expect(errors).toEqual([]);
  });
});
