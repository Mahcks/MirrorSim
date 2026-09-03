const AIRPLAY_MUTE_DB = -100;

export function airPlayVolumeDbToGain(volumeDb: number | null): number {
  if (volumeDb === null || !Number.isFinite(volumeDb)) {
    return 1;
  }
  if (volumeDb <= AIRPLAY_MUTE_DB) {
    return 0;
  }

  return Math.min(1, Math.max(0, 10 ** (Math.min(0, volumeDb) / 20)));
}

export function effectivePlaybackGain({
  muted,
  masterVolume,
  followIphoneVolume,
  senderVolumeDb,
}: {
  muted: boolean;
  masterVolume: number;
  followIphoneVolume: boolean;
  senderVolumeDb: number | null;
}): number {
  if (muted) {
    return 0;
  }

  const masterGain = Math.min(1, Math.max(0, masterVolume));
  const senderGain = followIphoneVolume ? airPlayVolumeDbToGain(senderVolumeDb) : 1;
  return masterGain * senderGain;
}

export function formatAirPlayVolume(volumeDb: number | null): string {
  if (volumeDb === null || !Number.isFinite(volumeDb)) {
    return "Waiting for an iPhone volume change";
  }
  if (volumeDb <= AIRPLAY_MUTE_DB) {
    return "Muted on iPhone";
  }
  if (volumeDb >= -0.05) {
    return "Maximum on iPhone";
  }
  return `${volumeDb.toFixed(1)} dB from iPhone`;
}
