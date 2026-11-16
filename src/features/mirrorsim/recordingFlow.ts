import type { RecordingFormat } from "./types";

export type RecordingFailureStage = "starting" | "stopping-backend" | "finalizing";

export function getRecordingFailureRecovery(
  stage: RecordingFailureStage,
  recorderCreated: boolean,
) {
  const abortWorkspace = stage === "starting" && !recorderCreated;
  return {
    abortWorkspace,
    preserveForRetry: !abortWorkspace,
  };
}

const MIME_CANDIDATES: Record<RecordingFormat, { withAudio: string[]; videoOnly: string[] }> = {
  // avc1.640034 is H.264 High 5.2, which covers framed captures wider than 1080p.
  mp4: {
    withAudio: [
      "video/mp4;codecs=avc1.640034,mp4a.40.2",
      "video/mp4;codecs=avc1,mp4a.40.2",
      "video/mp4;codecs=avc1,opus",
      "video/mp4",
    ],
    videoOnly: ["video/mp4;codecs=avc1.640034", "video/mp4;codecs=avc1", "video/mp4"],
  },
  webm: {
    withAudio: ["video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm"],
    videoOnly: ["video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm"],
  },
};

export type ResolvedRecordingFormat = {
  format: RecordingFormat;
  mimeType: string;
  fellBack: boolean;
};

/**
 * Picks the first container/codec combination the recorder supports, trying the
 * preferred format before the other one. Returns null when neither works.
 */
export function resolveRecordingFormat(
  preferred: RecordingFormat,
  hasAudio: boolean,
  isTypeSupported: (mimeType: string) => boolean,
): ResolvedRecordingFormat | null {
  const order: RecordingFormat[] = preferred === "mp4" ? ["mp4", "webm"] : ["webm", "mp4"];
  for (const format of order) {
    const candidates = hasAudio ? MIME_CANDIDATES[format].withAudio : MIME_CANDIDATES[format].videoOnly;
    const mimeType = candidates.find((candidate) => isTypeSupported(candidate));
    if (mimeType) {
      return { format, mimeType, fellBack: format !== preferred };
    }
  }
  return null;
}

const MIN_VIDEO_BITS_PER_SECOND = 4_000_000;
const MAX_VIDEO_BITS_PER_SECOND = 20_000_000;

/** About 0.2 bits per pixel at 30 fps: crisp text and UI without huge files. */
export function recordingVideoBitsPerSecond(width: number, height: number): number {
  const target = Math.round(width * height * 30 * 0.2);
  return Math.min(MAX_VIDEO_BITS_PER_SECOND, Math.max(MIN_VIDEO_BITS_PER_SECOND, target));
}
