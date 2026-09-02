import { describe, expect, test } from "bun:test";

import { getLivePlaybackCorrection } from "../src/features/mirrorsim/livePlayback";

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

  test("jumps close to live after a wake-up backlog", () => {
    expect(getLivePlaybackCorrection({
      currentTime: 10,
      bufferedEnd: 13,
      paused: false,
      readyState: 4,
      ...balancedTuning,
    })).toEqual({
      leadSeconds: 3,
      playbackRate: 1,
      seekTime: 12.75,
    });
  });

  test("does not seek or accelerate while playback is paused", () => {
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
    });
  });
});
