import { describe, expect, test } from "bun:test";

import {
  decodePreviewMediaSegmentResponse,
  decodePreviewVideoAccessUnitResponse,
  clearRetainedPreviewFrame,
  getRetainedPreviewFrame,
  retainPreviewFrame,
} from "../src/mockPreviewStream";

describe("preview media binary transport", () => {
  test("decodes the segment metadata header without JSON-expanding the media bytes", () => {
    const bytes = new Uint8Array(28);
    const view = new DataView(bytes.buffer);
    view.setUint32(0, 42, true);
    view.setUint32(4, 100, true);
    view.setUint32(8, 103, true);
    view.setUint8(12, 1);
    view.setBigUint64(13, 2_000_000n, true);
    view.setUint32(21, 66_668, true);
    bytes.set([1, 2, 3], 25);

    const segment = decodePreviewMediaSegmentResponse(bytes.buffer);

    expect(segment?.sequenceNumber).toBe(42);
    expect(segment?.firstSampleIndex).toBe(100);
    expect(segment?.lastSampleIndex).toBe(103);
    expect(segment?.startsWithKeyframe).toBe(true);
    expect(segment?.decodeTime).toBe(2_000_000);
    expect(segment?.duration).toBe(66_668);
    expect(Array.from(new Uint8Array(segment?.bytes ?? new ArrayBuffer(0)))).toEqual([1, 2, 3]);
  });

  test("uses an empty response to represent no queued segment", () => {
    expect(decodePreviewMediaSegmentResponse(new ArrayBuffer(0))).toBeNull();
  });

  test("rejects a truncated binary header", () => {
    expect(() => decodePreviewMediaSegmentResponse(new ArrayBuffer(24))).toThrow("binary header");
  });
});

describe("preview WebCodecs binary transport", () => {
  test("decodes one access unit without JSON-expanding the H.264 bytes", () => {
    const bytes = new Uint8Array(20);
    const view = new DataView(bytes.buffer);
    view.setUint32(0, 73, true);
    view.setUint8(4, 1);
    view.setBigUint64(5, 3_500_000n, true);
    view.setUint32(13, 33_333, true);
    bytes.set([4, 5, 6], 17);

    const accessUnit = decodePreviewVideoAccessUnitResponse(bytes.buffer);

    expect(accessUnit?.sequenceNumber).toBe(73);
    expect(accessUnit?.keyframe).toBe(true);
    expect(accessUnit?.needsRandomAccess).toBe(false);
    expect(accessUnit?.clientInvalidated).toBe(false);
    expect(accessUnit?.timestamp).toBe(3_500_000);
    expect(accessUnit?.duration).toBe(33_333);
    expect(Array.from(new Uint8Array(accessUnit?.bytes ?? new ArrayBuffer(0)))).toEqual([4, 5, 6]);
  });

  test("rejects a truncated access-unit header", () => {
    expect(() => decodePreviewVideoAccessUnitResponse(new ArrayBuffer(16))).toThrow("binary header");
  });

  test("decodes a random-access recovery signal without media bytes", () => {
    const bytes = new Uint8Array(17);
    new DataView(bytes.buffer).setUint8(4, 2);

    const accessUnit = decodePreviewVideoAccessUnitResponse(bytes.buffer);

    expect(accessUnit?.keyframe).toBe(false);
    expect(accessUnit?.needsRandomAccess).toBe(true);
    expect(accessUnit?.bytes.byteLength).toBe(0);
  });

  test("distinguishes an invalidated decoder client from an empty queue", () => {
    const bytes = new Uint8Array(17);
    new DataView(bytes.buffer).setUint8(4, 4);

    const accessUnit = decodePreviewVideoAccessUnitResponse(bytes.buffer);

    expect(accessUnit?.clientInvalidated).toBe(true);
    expect(accessUnit?.needsRandomAccess).toBe(false);
    expect(accessUnit?.bytes.byteLength).toBe(0);
  });
});

describe("retained preview frames", () => {
  test("survives decoder teardown until the live session explicitly clears it", () => {
    const video = {} as HTMLVideoElement;
    const canvas = { width: 393, height: 852 } as HTMLCanvasElement;

    retainPreviewFrame(video, canvas);
    expect(getRetainedPreviewFrame(video)).toEqual({ canvas, width: 393, height: 852 });

    clearRetainedPreviewFrame(video);
    expect(getRetainedPreviewFrame(video)).toBeNull();
  });
});
