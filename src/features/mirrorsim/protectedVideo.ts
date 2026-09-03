import type { PreviewStreamClientDiagnostics } from "@/mockPreviewStream";

export const PAUSED_PICTURE_CONFIRMATION_MS = 2_000;
export const PROTECTED_VIDEO_MIN_PROBES = 8;
export const PROTECTED_VIDEO_MIN_SPAN_MS = 7_000;

const AUDIO_FRESH_MS = 2_500;
const AUDIO_EXIT_GRACE_MS = 3_000;
const PROBE_FRESH_MS = 2_500;
const PAUSED_PROBE_FRESH_MS = 3_000;
const RESUME_PROBE_GRACE_MS = 3_000;
const CLEAR_PROBE_COUNT = 2;

export type VideoAvailabilityNotice = "sender-paused" | "possible-protected" | null;

type PixelEvidence = Pick<
  PreviewStreamClientDiagnostics,
  | "playbackBackend"
  | "decodedOutputCount"
  | "lastDecodedFrameAtMs"
  | "renderSurfaceConnected"
  | "renderSurfaceHealthy"
  | "pixelProbeAverageLuma"
  | "pixelProbeDarkRatio"
  | "pixelProbeCenterAverageLuma"
  | "pixelProbeCenterDarkRatio"
  | "pixelProbeBrightRatio"
  | "pixelProbeEdgeRatio"
  | "pixelProbeSequence"
  | "pixelProbeDecodedOutputCount"
  | "lastPixelProbeAtMs"
>;

export type VideoAvailabilityObservation = PixelEvidence & {
  streamKey: string | null;
  isLive: boolean;
  previewReady: boolean;
  documentVisible: boolean;
  senderPaused: boolean;
  lastAudioReceivedAtMs: number | null;
  lastAudibleAudioAtMs: number | null;
  nowMs: number;
};

export type VideoAvailabilityDetectorState = {
  streamKey: string | null;
  notice: VideoAvailabilityNotice;
  pauseCandidateSinceMs: number | null;
  pauseCandidateAudioAtMs: number | null;
  resumeCandidateSinceMs: number | null;
  pixelCandidateSinceMs: number | null;
  pixelCandidateProbeCount: number;
  pixelCandidateLastDecodedCount: number;
  lastProcessedProbeSequence: number;
  consecutiveVisibleProbes: number;
};

export function createVideoAvailabilityDetectorState(
  streamKey: string | null = null,
): VideoAvailabilityDetectorState {
  return {
    streamKey,
    notice: null,
    pauseCandidateSinceMs: null,
    pauseCandidateAudioAtMs: null,
    resumeCandidateSinceMs: null,
    pixelCandidateSinceMs: null,
    pixelCandidateProbeCount: 0,
    pixelCandidateLastDecodedCount: 0,
    lastProcessedProbeSequence: 0,
    consecutiveVisibleProbes: 0,
  };
}

function isRecent(nowMs: number, observedAtMs: number | null, maximumAgeMs: number) {
  if (observedAtMs === null) return false;
  const ageMs = nowMs - observedAtMs;
  return ageMs >= 0 && ageMs <= maximumAgeMs;
}

export function isNearlyBlackVideoSurface(
  evidence: Pick<
    PixelEvidence,
    | "pixelProbeAverageLuma"
    | "pixelProbeDarkRatio"
    | "pixelProbeCenterAverageLuma"
    | "pixelProbeCenterDarkRatio"
    | "pixelProbeBrightRatio"
    | "pixelProbeEdgeRatio"
  >,
) {
  const {
    pixelProbeAverageLuma,
    pixelProbeDarkRatio,
    pixelProbeCenterAverageLuma,
    pixelProbeCenterDarkRatio,
    pixelProbeBrightRatio,
    pixelProbeEdgeRatio,
  } = evidence;
  return pixelProbeAverageLuma !== null
    && pixelProbeDarkRatio !== null
    && pixelProbeCenterAverageLuma !== null
    && pixelProbeCenterDarkRatio !== null
    && pixelProbeBrightRatio !== null
    && pixelProbeEdgeRatio !== null
    && pixelProbeAverageLuma <= 36
    && pixelProbeDarkRatio >= 0.82
    && pixelProbeCenterAverageLuma <= 28
    && pixelProbeCenterDarkRatio >= 0.86
    && pixelProbeBrightRatio <= 0.12
    && pixelProbeEdgeRatio <= 0.16;
}

export function reduceVideoAvailability(
  previous: VideoAvailabilityDetectorState,
  observation: VideoAvailabilityObservation,
): VideoAvailabilityDetectorState {
  let state = previous.streamKey === observation.streamKey
    ? { ...previous }
    : createVideoAvailabilityDetectorState(observation.streamKey);

  const globallyHealthy = observation.streamKey !== null
    && observation.isLive
    && observation.previewReady
    && observation.documentVisible
    && observation.playbackBackend !== null
    && observation.renderSurfaceConnected
    && observation.renderSurfaceHealthy;
  if (!globallyHealthy) {
    return createVideoAvailabilityDetectorState(observation.streamKey);
  }

  const receivedAudioIsFresh = isRecent(
    observation.nowMs,
    observation.lastAudioReceivedAtMs,
    state.notice === null ? AUDIO_FRESH_MS : AUDIO_EXIT_GRACE_MS,
  );
  const audibleAudioIsFresh = isRecent(
    observation.nowMs,
    observation.lastAudibleAudioAtMs,
    state.notice === null ? AUDIO_FRESH_MS : AUDIO_EXIT_GRACE_MS,
  );
  const probeIsFresh = isRecent(observation.nowMs, observation.lastPixelProbeAtMs, PROBE_FRESH_MS);
  const pausedProbeIsFresh = isRecent(
    observation.nowMs,
    observation.lastPixelProbeAtMs,
    PAUSED_PROBE_FRESH_MS,
  );
  const surfaceIsNearlyBlack = isNearlyBlackVideoSurface(observation);
  const hasNewProbe = observation.pixelProbeSequence !== state.lastProcessedProbeSequence;
  if (hasNewProbe) {
    state.lastProcessedProbeSequence = observation.pixelProbeSequence;
  }

  if (state.notice === "sender-paused") {
    if (observation.senderPaused) {
      state.resumeCandidateSinceMs = null;
    } else if (state.resumeCandidateSinceMs === null) {
      state.resumeCandidateSinceMs = observation.nowMs;
    }

    if (hasNewProbe) {
      state.consecutiveVisibleProbes = surfaceIsNearlyBlack
        ? 0
        : state.consecutiveVisibleProbes + 1;
      if (state.consecutiveVisibleProbes >= CLEAR_PROBE_COUNT) {
        return createVideoAvailabilityDetectorState(observation.streamKey);
      }
    }

    if (
      !observation.senderPaused
      && !probeIsFresh
      && state.resumeCandidateSinceMs !== null
      && observation.nowMs - state.resumeCandidateSinceMs >= RESUME_PROBE_GRACE_MS
    ) {
      return createVideoAvailabilityDetectorState(observation.streamKey);
    }
    return state;
  }

  if (state.notice === "possible-protected") {
    if (observation.senderPaused) {
      state.notice = "sender-paused";
      state.pauseCandidateSinceMs = null;
      state.pauseCandidateAudioAtMs = null;
      state.resumeCandidateSinceMs = null;
      state.consecutiveVisibleProbes = 0;
      return state;
    } else if (!receivedAudioIsFresh || !audibleAudioIsFresh || !probeIsFresh) {
      return createVideoAvailabilityDetectorState(observation.streamKey);
    } else if (hasNewProbe) {
      state.consecutiveVisibleProbes = surfaceIsNearlyBlack
        ? 0
        : state.consecutiveVisibleProbes + 1;
      if (state.consecutiveVisibleProbes >= CLEAR_PROBE_COUNT) {
        return createVideoAvailabilityDetectorState(observation.streamKey);
      }
      return state;
    } else {
      return state;
    }
  }

  if (observation.senderPaused) {
    state.pixelCandidateSinceMs = null;
    state.pixelCandidateProbeCount = 0;
    state.pixelCandidateLastDecodedCount = 0;
    if (!surfaceIsNearlyBlack || !pausedProbeIsFresh || !receivedAudioIsFresh) {
      state.pauseCandidateSinceMs = null;
      state.pauseCandidateAudioAtMs = null;
      return state;
    }
    if (state.pauseCandidateSinceMs === null) {
      state.pauseCandidateSinceMs = observation.nowMs;
      state.pauseCandidateAudioAtMs = observation.lastAudioReceivedAtMs;
      return state;
    }
    const audioAdvanced = observation.lastAudioReceivedAtMs !== null
      && state.pauseCandidateAudioAtMs !== null
      && observation.lastAudioReceivedAtMs > state.pauseCandidateAudioAtMs;
    if (
      observation.nowMs - state.pauseCandidateSinceMs >= PAUSED_PICTURE_CONFIRMATION_MS
      && audioAdvanced
    ) {
      state.notice = "sender-paused";
    }
    return state;
  }

  state.pauseCandidateSinceMs = null;
  state.pauseCandidateAudioAtMs = null;
  if (!receivedAudioIsFresh || !audibleAudioIsFresh) {
    state.pixelCandidateSinceMs = null;
    state.pixelCandidateProbeCount = 0;
    state.pixelCandidateLastDecodedCount = 0;
    return state;
  }
  if (!hasNewProbe) return state;

  const probeTracksNewDecodedOutput = observation.pixelProbeDecodedOutputCount !== null
    && observation.pixelProbeDecodedOutputCount > state.pixelCandidateLastDecodedCount
    && observation.lastDecodedFrameAtMs === observation.lastPixelProbeAtMs;
  if (!probeIsFresh || !surfaceIsNearlyBlack || !probeTracksNewDecodedOutput) {
    state.pixelCandidateSinceMs = null;
    state.pixelCandidateProbeCount = 0;
    state.pixelCandidateLastDecodedCount = 0;
    return state;
  }

  if (state.pixelCandidateSinceMs === null) {
    state.pixelCandidateSinceMs = observation.lastPixelProbeAtMs;
  }
  const pixelCandidateSinceMs = state.pixelCandidateSinceMs;
  state.pixelCandidateProbeCount += 1;
  state.pixelCandidateLastDecodedCount = observation.pixelProbeDecodedOutputCount ?? 0;
  if (
    state.pixelCandidateProbeCount >= PROTECTED_VIDEO_MIN_PROBES
    && observation.lastPixelProbeAtMs !== null
    && pixelCandidateSinceMs !== null
    && observation.lastPixelProbeAtMs - pixelCandidateSinceMs >= PROTECTED_VIDEO_MIN_SPAN_MS
  ) {
    state.notice = "possible-protected";
  }
  return state;
}
