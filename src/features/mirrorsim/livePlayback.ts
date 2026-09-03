export type LivePlaybackCorrection = {
  leadSeconds: number;
  playbackRate: number;
  seekTime: number | null;
  shouldPlay: boolean;
};

export type LivePlaybackRecoveryAction = "none" | "nudge";

type LivePlaybackCorrectionInput = {
  currentTime: number;
  bufferedEnd: number;
  paused: boolean;
  readyState: number;
  catchupLeadSeconds: number;
  catchupTargetOffsetSeconds: number;
};

export function getLivePlaybackCorrection({
  currentTime,
  bufferedEnd,
  paused,
  readyState,
  catchupLeadSeconds,
  catchupTargetOffsetSeconds,
}: LivePlaybackCorrectionInput): LivePlaybackCorrection {
  const leadSeconds = Math.max(0, bufferedEnd - currentTime);
  if (paused || readyState < 2) {
    return {
      leadSeconds,
      playbackRate: 1,
      seekTime: null,
      shouldPlay: true,
    };
  }

  const softCatchupRate = leadSeconds > catchupLeadSeconds ? 1.25 : 1;
  const catchupRate = leadSeconds > Math.max(0.9, catchupLeadSeconds * 2)
    ? 2
    : softCatchupRate;
  const playbackRate = leadSeconds <= catchupTargetOffsetSeconds + 0.15
    ? 1
    : catchupRate;

  return { leadSeconds, playbackRate, seekTime: null, shouldPlay: false };
}

type LivePlaybackRecoveryInput = {
  receivingSegments: boolean;
  stalledForMs: number;
};

export function getLivePlaybackRecovery({
  receivingSegments,
  stalledForMs,
}: LivePlaybackRecoveryInput): LivePlaybackRecoveryAction {
  if (!receivingSegments || stalledForMs < 2_000) {
    return "none";
  }

  return "nudge";
}
