import { describe, expect, test } from "bun:test";

import {
  createVideoAvailabilityDetectorState,
  isNearlyBlackVideoSurface,
  reduceVideoAvailability,
  type VideoAvailabilityObservation,
} from "../src/features/mirrorsim/protectedVideo";

function observation(
  overrides: Partial<VideoAvailabilityObservation> = {},
): VideoAvailabilityObservation {
  return {
    streamKey: "stream-1:1",
    isLive: true,
    previewReady: true,
    documentVisible: true,
    senderPaused: false,
    playbackBackend: "webcodecs",
    decodedOutputCount: 100,
    lastDecodedFrameAtMs: 10_000,
    renderSurfaceConnected: true,
    renderSurfaceHealthy: true,
    pixelProbeAverageLuma: 8,
    pixelProbeDarkRatio: 0.97,
    pixelProbeCenterAverageLuma: 4,
    pixelProbeCenterDarkRatio: 0.99,
    pixelProbeBrightRatio: 0.02,
    pixelProbeEdgeRatio: 0.04,
    pixelProbeSequence: 1,
    pixelProbeDecodedOutputCount: 100,
    lastPixelProbeAtMs: 10_000,
    lastAudioReceivedAtMs: 10_000,
    lastAudibleAudioAtMs: 10_000,
    nowMs: 10_000,
    ...overrides,
  };
}

describe("protected video surface classification", () => {
  test("accepts sparse controls over a uniformly black center", () => {
    expect(isNearlyBlackVideoSurface(observation())).toBe(true);
  });

  test("rejects a detailed dark interface", () => {
    expect(isNearlyBlackVideoSurface(observation({
      pixelProbeAverageLuma: 25,
      pixelProbeDarkRatio: 0.88,
      pixelProbeCenterAverageLuma: 20,
      pixelProbeCenterDarkRatio: 0.9,
      pixelProbeBrightRatio: 0.08,
      pixelProbeEdgeRatio: 0.24,
    }))).toBe(false);
  });
});

describe("video availability state machine", () => {
  test("shows a neutral paused-picture notice after typed pause and continuing PCM", () => {
    let state = reduceVideoAvailability(
      createVideoAvailabilityDetectorState(),
      observation({ senderPaused: true }),
    );
    state = reduceVideoAvailability(state, observation({
      senderPaused: true,
      nowMs: 12_100,
      lastAudioReceivedAtMs: 12_000,
    }));

    expect(state.notice).toBe("sender-paused");
  });

  test("does not confirm sender pause from one stale audio receipt", () => {
    let state = reduceVideoAvailability(
      createVideoAvailabilityDetectorState(),
      observation({ senderPaused: true }),
    );
    state = reduceVideoAvailability(state, observation({
      senderPaused: true,
      nowMs: 12_100,
    }));

    expect(state.notice).toBeNull();
  });

  test("does not hide a visible paused frame", () => {
    const state = reduceVideoAvailability(
      createVideoAvailabilityDetectorState(),
      observation({
        senderPaused: true,
        pixelProbeAverageLuma: 70,
        pixelProbeDarkRatio: 0.4,
        pixelProbeCenterAverageLuma: 65,
        pixelProbeCenterDarkRatio: 0.35,
      }),
    );

    expect(state.notice).toBeNull();
  });

  test("requires eight advancing black probes over seven seconds", () => {
    let state = createVideoAvailabilityDetectorState();
    for (let index = 0; index < 8; index += 1) {
      const timestamp = 10_000 + index * 1_000;
      state = reduceVideoAvailability(state, observation({
        decodedOutputCount: 100 + index,
        lastDecodedFrameAtMs: timestamp,
        pixelProbeSequence: index + 1,
        pixelProbeDecodedOutputCount: 100 + index,
        lastPixelProbeAtMs: timestamp,
        lastAudioReceivedAtMs: timestamp,
        lastAudibleAudioAtMs: timestamp,
        nowMs: timestamp,
      }));
    }

    expect(state.notice).toBe("possible-protected");
  });

  test("never confirms a cached or frozen black frame", () => {
    let state = reduceVideoAvailability(
      createVideoAvailabilityDetectorState(),
      observation(),
    );
    state = reduceVideoAvailability(state, observation({
      nowMs: 18_000,
      lastAudioReceivedAtMs: 18_000,
      lastAudibleAudioAtMs: 18_000,
    }));

    expect(state.pixelCandidateProbeCount).toBe(1);
    expect(state.notice).toBeNull();
  });

  test("silent PCM cannot confirm protected content", () => {
    let state = createVideoAvailabilityDetectorState();
    for (let index = 0; index < 10; index += 1) {
      const timestamp = 10_000 + index * 1_000;
      state = reduceVideoAvailability(state, observation({
        decodedOutputCount: 100 + index,
        lastDecodedFrameAtMs: timestamp,
        pixelProbeSequence: index + 1,
        pixelProbeDecodedOutputCount: 100 + index,
        lastPixelProbeAtMs: timestamp,
        lastAudioReceivedAtMs: timestamp,
        lastAudibleAudioAtMs: null,
        nowMs: timestamp,
      }));
    }

    expect(state.notice).toBeNull();
  });

  test("transport interruption and hidden-window time reset candidacy", () => {
    let state = reduceVideoAvailability(
      createVideoAvailabilityDetectorState(),
      observation({ senderPaused: true }),
    );
    state = reduceVideoAvailability(state, observation({
      senderPaused: true,
      isLive: false,
      previewReady: false,
      nowMs: 20_000,
    }));
    expect(state.notice).toBeNull();
    expect(state.pauseCandidateSinceMs).toBeNull();

    state = reduceVideoAvailability(state, observation({
      senderPaused: true,
      documentVisible: false,
      nowMs: 30_000,
    }));
    expect(state.pauseCandidateSinceMs).toBeNull();
  });

  test("a transient sender resume over black controls does not uncover protected playback", () => {
    let state = reduceVideoAvailability(
      createVideoAvailabilityDetectorState(),
      observation({ senderPaused: true }),
    );
    state = reduceVideoAvailability(state, observation({
      senderPaused: true,
      nowMs: 12_100,
      lastAudioReceivedAtMs: 12_000,
    }));
    expect(state.notice).toBe("sender-paused");

    state = reduceVideoAvailability(state, observation({
      senderPaused: false,
      nowMs: 12_200,
      lastAudioReceivedAtMs: 12_200,
      lastAudibleAudioAtMs: 12_200,
    }));
    expect(state.notice).toBe("sender-paused");

    const visible = {
      pixelProbeAverageLuma: 90,
      pixelProbeDarkRatio: 0.3,
      pixelProbeCenterAverageLuma: 80,
      pixelProbeCenterDarkRatio: 0.25,
      pixelProbeBrightRatio: 0.4,
      pixelProbeEdgeRatio: 0.25,
    };
    state = reduceVideoAvailability(state, observation({
      ...visible,
      senderPaused: false,
      decodedOutputCount: 101,
      lastDecodedFrameAtMs: 12_300,
      pixelProbeSequence: 2,
      pixelProbeDecodedOutputCount: 101,
      lastPixelProbeAtMs: 12_300,
      nowMs: 12_300,
    }));
    expect(state.notice).toBe("sender-paused");
    state = reduceVideoAvailability(state, observation({
      ...visible,
      senderPaused: false,
      decodedOutputCount: 102,
      lastDecodedFrameAtMs: 12_400,
      pixelProbeSequence: 3,
      pixelProbeDecodedOutputCount: 102,
      lastPixelProbeAtMs: 12_400,
      nowMs: 12_400,
    }));
    expect(state.notice).toBeNull();
  });

  test("a confirmed sender pause survives a temporary audio gap", () => {
    let state = reduceVideoAvailability(
      createVideoAvailabilityDetectorState(),
      observation({ senderPaused: true }),
    );
    state = reduceVideoAvailability(state, observation({
      senderPaused: true,
      nowMs: 12_100,
      lastAudioReceivedAtMs: 12_000,
    }));
    expect(state.notice).toBe("sender-paused");

    state = reduceVideoAvailability(state, observation({
      senderPaused: true,
      nowMs: 20_000,
      lastAudioReceivedAtMs: 12_000,
      lastAudibleAudioAtMs: 12_000,
    }));
    expect(state.notice).toBe("sender-paused");
  });

  test("a resumed sender without fresh picture evidence eventually clears the notice", () => {
    let state = reduceVideoAvailability(
      createVideoAvailabilityDetectorState(),
      observation({ senderPaused: true }),
    );
    state = reduceVideoAvailability(state, observation({
      senderPaused: true,
      nowMs: 12_100,
      lastAudioReceivedAtMs: 12_000,
    }));
    state = reduceVideoAvailability(state, observation({
      senderPaused: false,
      nowMs: 12_200,
      lastPixelProbeAtMs: 10_000,
    }));
    expect(state.notice).toBe("sender-paused");
    state = reduceVideoAvailability(state, observation({
      senderPaused: false,
      nowMs: 15_300,
      lastPixelProbeAtMs: 10_000,
    }));
    expect(state.notice).toBeNull();
  });

  test("two visible probes clear a protected-surface notice", () => {
    let state = createVideoAvailabilityDetectorState();
    for (let index = 0; index < 8; index += 1) {
      const timestamp = 10_000 + index * 1_000;
      state = reduceVideoAvailability(state, observation({
        decodedOutputCount: 100 + index,
        lastDecodedFrameAtMs: timestamp,
        pixelProbeSequence: index + 1,
        pixelProbeDecodedOutputCount: 100 + index,
        lastPixelProbeAtMs: timestamp,
        lastAudioReceivedAtMs: timestamp,
        lastAudibleAudioAtMs: timestamp,
        nowMs: timestamp,
      }));
    }

    const visible = {
      pixelProbeAverageLuma: 90,
      pixelProbeDarkRatio: 0.3,
      pixelProbeCenterAverageLuma: 80,
      pixelProbeCenterDarkRatio: 0.25,
      pixelProbeBrightRatio: 0.4,
      pixelProbeEdgeRatio: 0.25,
    };
    state = reduceVideoAvailability(state, observation({
      ...visible,
      decodedOutputCount: 200,
      lastDecodedFrameAtMs: 18_000,
      pixelProbeSequence: 9,
      pixelProbeDecodedOutputCount: 200,
      lastPixelProbeAtMs: 18_000,
      lastAudioReceivedAtMs: 18_000,
      lastAudibleAudioAtMs: 18_000,
      nowMs: 18_000,
    }));
    expect(state.notice).toBe("possible-protected");
    state = reduceVideoAvailability(state, observation({
      ...visible,
      decodedOutputCount: 201,
      lastDecodedFrameAtMs: 19_000,
      pixelProbeSequence: 10,
      pixelProbeDecodedOutputCount: 201,
      lastPixelProbeAtMs: 19_000,
      lastAudioReceivedAtMs: 19_000,
      lastAudibleAudioAtMs: 19_000,
      nowMs: 19_000,
    }));
    expect(state.notice).toBeNull();
  });

  test("future timestamps are not treated as fresh evidence", () => {
    const state = reduceVideoAvailability(
      createVideoAvailabilityDetectorState(),
      observation({
        senderPaused: true,
        lastAudioReceivedAtMs: 11_000,
        lastPixelProbeAtMs: 11_000,
        nowMs: 10_000,
      }),
    );
    expect(state.pauseCandidateSinceMs).toBeNull();
  });

  test("works with the MSE fallback when frame probes are available", () => {
    const state = reduceVideoAvailability(
      createVideoAvailabilityDetectorState(),
      observation({ playbackBackend: "mse" }),
    );
    expect(state.pixelCandidateProbeCount).toBe(1);
  });
});
