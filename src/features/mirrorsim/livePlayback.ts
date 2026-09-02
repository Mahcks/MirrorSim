export type LivePlaybackCorrection = {
  leadSeconds: number;
  playbackRate: number;
  seekTime: number | null;
};

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
    return { leadSeconds, playbackRate: 1, seekTime: null };
  }

  const hardCatchupLead = Math.max(1.25, catchupLeadSeconds * 4);
  const safeLiveOffset = Math.max(0.25, catchupTargetOffsetSeconds * 4);
  const liveEdgeTarget = Math.max(0, bufferedEnd - safeLiveOffset);
  if (leadSeconds > hardCatchupLead && liveEdgeTarget > currentTime + 0.35) {
    return { leadSeconds, playbackRate: 1, seekTime: liveEdgeTarget };
  }

  const softCatchupRate = leadSeconds > catchupLeadSeconds ? 1.25 : 1;
  const catchupRate = leadSeconds > Math.max(0.9, catchupLeadSeconds * 2)
    ? 1.5
    : softCatchupRate;
  const playbackRate = leadSeconds <= catchupTargetOffsetSeconds + 0.15
    ? 1
    : catchupRate;

  return { leadSeconds, playbackRate, seekTime: null };
}
