import { describe, expect, test } from "bun:test";

import {
  getLivePlaybackCorrection,
  getLivePlaybackRecovery,
} from "../src/features/mirrorsim/livePlayback";

const balancedTuning = {
  catchupLeadSeconds: 0.35,
  catchupTargetOffsetSeconds: 0.06,
};

describe("live preview catch-up", () => {
  test("plays small drift faster without seeking", () => {
    const correction = getLivePlaybackCorrection({
      currentTime: 10,
      bufferedEnd: 10.7,
      paused: false,
      readyState: 4,
      ...balancedTuning,
    });

    expect(correction.leadSeconds).toBeCloseTo(0.7);
    expect(correction.playbackRate).toBe(1.25);
    expect(correction.seekTime).toBeNull();
  });

  test("catches up without seeking after a wake-up backlog", () => {
    expect(getLivePlaybackCorrection({
      currentTime: 10,
      bufferedEnd: 13,
      paused: false,
      readyState: 4,
      ...balancedTuning,
    })).toEqual({
      leadSeconds: 3,
      playbackRate: 2,
      seekTime: null,
      shouldPlay: false,
    });
  });

  test("resumes a paused live surface without seeking into a delta frame", () => {
    expect(getLivePlaybackCorrection({
      currentTime: 10,
      bufferedEnd: 13,
      paused: true,
      readyState: 4,
      ...balancedTuning,
    })).toEqual({
      leadSeconds: 3,
      playbackRate: 1,
      seekTime: null,
      shouldPlay: true,
    });
  });

  test("nudges a stalled surface without discarding its decoder", () => {
    expect(getLivePlaybackRecovery({
      receivingSegments: true,
      stalledForMs: 2_100,
    })).toBe("nudge");
  });

  test("does not recover when the sender has stopped delivering segments", () => {
    expect(getLivePlaybackRecovery({
      receivingSegments: false,
      stalledForMs: 10_000,
    })).toBe("none");
  });
});
