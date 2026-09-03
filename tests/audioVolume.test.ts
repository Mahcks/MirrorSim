import { describe, expect, test } from "bun:test";

import {
  airPlayVolumeDbToGain,
  effectivePlaybackGain,
  formatAirPlayVolume,
} from "../src/features/mirrorsim/audioVolume";

describe("AirPlay volume", () => {
  test("converts decibel attenuation to linear gain", () => {
    expect(airPlayVolumeDbToGain(0)).toBe(1);
    expect(airPlayVolumeDbToGain(-6)).toBeCloseTo(0.501, 3);
    expect(airPlayVolumeDbToGain(-20)).toBeCloseTo(0.1, 5);
    expect(airPlayVolumeDbToGain(-144)).toBe(0);
  });

  test("combines sender attenuation with the local master", () => {
    expect(effectivePlaybackGain({
      muted: false,
      masterVolume: 0.8,
      followIphoneVolume: true,
      senderVolumeDb: -6,
    })).toBeCloseTo(0.401, 3);

    expect(effectivePlaybackGain({
      muted: false,
      masterVolume: 0.8,
      followIphoneVolume: false,
      senderVolumeDb: -144,
    })).toBe(0.8);
  });

  test("desktop mute always wins", () => {
    expect(effectivePlaybackGain({
      muted: true,
      masterVolume: 1,
      followIphoneVolume: true,
      senderVolumeDb: 0,
    })).toBe(0);
  });

  test("describes unavailable and muted sender levels", () => {
    expect(formatAirPlayVolume(null)).toBe("Waiting for an iPhone volume change");
    expect(formatAirPlayVolume(-144)).toBe("Muted on iPhone");
  });
});
