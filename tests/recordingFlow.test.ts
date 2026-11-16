import { describe, expect, test } from "bun:test";

import { gifFrameSize } from "../src/features/mirrorsim/gifRecorder";
import {
  getRecordingFailureRecovery,
  recordingVideoBitsPerSecond,
  resolveRecordingFormat,
} from "../src/features/mirrorsim/recordingFlow";

describe("recording failure recovery", () => {
  test("never aborts an established recording during stop or finalization", () => {
    expect(getRecordingFailureRecovery("stopping-backend", true)).toEqual({
      abortWorkspace: false,
      preserveForRetry: true,
    });
    expect(getRecordingFailureRecovery("finalizing", true)).toEqual({
      abortWorkspace: false,
      preserveForRetry: true,
    });
  });

  test("only an unstarted workspace can be aborted automatically", () => {
    expect(getRecordingFailureRecovery("starting", false).abortWorkspace).toBe(true);
    expect(getRecordingFailureRecovery("starting", true).abortWorkspace).toBe(false);
  });
});

describe("recording format selection", () => {
  const supports = (...types: string[]) => (mimeType: string) => types.includes(mimeType);

  test("prefers H.264 MP4 with AAC audio", () => {
    expect(resolveRecordingFormat("mp4", true, supports(
      "video/mp4;codecs=avc1.640034,mp4a.40.2",
      "video/webm;codecs=vp9,opus",
    ))).toEqual({ format: "mp4", mimeType: "video/mp4;codecs=avc1.640034,mp4a.40.2", fellBack: false });
  });

  test("uses a video-only codec string without audio", () => {
    expect(resolveRecordingFormat("mp4", false, supports("video/mp4;codecs=avc1"))?.mimeType)
      .toBe("video/mp4;codecs=avc1");
  });

  test("falls back to WebM when MP4 is unavailable", () => {
    expect(resolveRecordingFormat("mp4", true, supports("video/webm;codecs=vp9,opus")))
      .toEqual({ format: "webm", mimeType: "video/webm;codecs=vp9,opus", fellBack: true });
  });

  test("honors an explicit WebM preference", () => {
    expect(resolveRecordingFormat("webm", false, supports("video/mp4", "video/webm;codecs=vp8"))?.format)
      .toBe("webm");
  });

  test("returns null when nothing is supported", () => {
    expect(resolveRecordingFormat("mp4", true, () => false)).toBeNull();
  });
});

describe("recording bitrate", () => {
  test("stays within its floor and ceiling", () => {
    expect(recordingVideoBitsPerSecond(320, 240)).toBe(4_000_000);
    expect(recordingVideoBitsPerSecond(3132, 1440)).toBe(20_000_000);
  });

  test("scales with the captured size in between", () => {
    expect(recordingVideoBitsPerSecond(1080, 1920)).toBe(12_441_600);
  });
});

describe("GIF frame size", () => {
  test("fits a framed portrait capture within 480 x 960", () => {
    expect(gifFrameSize(1220, 2596)).toEqual({ width: 451, height: 960 });
  });

  test("fits landscape the same way, sideways", () => {
    expect(gifFrameSize(2596, 1220)).toEqual({ width: 960, height: 451 });
  });

  test("never upscales a small source", () => {
    expect(gifFrameSize(300, 200)).toEqual({ width: 300, height: 200 });
  });
});
