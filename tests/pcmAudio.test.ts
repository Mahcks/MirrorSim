import { describe, expect, test } from "bun:test";

import { decodePcm16Base64 } from "../src/features/mirrorsim/pcmAudio";

describe("PCM audio decoding", () => {
  test("deinterleaves signed little-endian stereo samples", () => {
    const payload = Buffer.from([
      0x00, 0x80, 0xff, 0x7f,
      0x00, 0x00, 0x00, 0xc0,
    ]).toString("base64");
    const channels = decodePcm16Base64(payload, 2);

    expect(channels).toHaveLength(2);
    expect(channels[0][0]).toBe(-1);
    expect(channels[0][1]).toBe(0);
    expect(channels[1][0]).toBeCloseTo(32767 / 32768, 5);
    expect(channels[1][1]).toBe(-0.5);
  });

  test("rejects incomplete sample frames", () => {
    expect(() => decodePcm16Base64(Buffer.from([0, 1, 2]).toString("base64"), 2)).toThrow();
  });

  test("mirrors an active stereo channel when its partner is effectively silent", () => {
    const bytes = Buffer.alloc(256 * 4);
    for (let sample = 0; sample < 256; sample += 1) {
      bytes.writeInt16LE(0, sample * 4);
      bytes.writeInt16LE(16_384, sample * 4 + 2);
    }

    const channels = decodePcm16Base64(bytes.toString("base64"), 2);
    expect(channels[0][0]).toBe(0.5);
    expect(channels[1][0]).toBe(0.5);
  });

  test("preserves ordinary stereo separation", () => {
    const bytes = Buffer.alloc(256 * 4);
    for (let sample = 0; sample < 256; sample += 1) {
      bytes.writeInt16LE(8_192, sample * 4);
      bytes.writeInt16LE(16_384, sample * 4 + 2);
    }

    const channels = decodePcm16Base64(bytes.toString("base64"), 2);
    expect(channels[0][0]).toBe(0.25);
    expect(channels[1][0]).toBe(0.5);
  });
});
