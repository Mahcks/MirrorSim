export function decodePcm16Base64(payload: string, channels: number) {
  if (!Number.isInteger(channels) || channels < 1 || channels > 2) {
    throw new Error("PCM audio must have one or two channels.");
  }

  const binary = atob(payload);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }

  const frameAlignment = channels * 2;
  if (bytes.byteLength === 0 || bytes.byteLength % frameAlignment !== 0) {
    throw new Error("PCM audio payload is not aligned to complete samples.");
  }

  const sampleCount = bytes.byteLength / frameAlignment;
  const samples = Array.from({ length: channels }, () => new Float32Array(sampleCount));
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let sample = 0; sample < sampleCount; sample += 1) {
    for (let channel = 0; channel < channels; channel += 1) {
      const offset = (sample * channels + channel) * 2;
      samples[channel][sample] = view.getInt16(offset, true) / 32768;
    }
  }

  repairEffectivelySilentStereoChannel(samples);

  return samples;
}

export function mixPcmChannelsToMono(channels: Float32Array[]): Float32Array[] {
  if (channels.length !== 2) {
    return channels;
  }

  const sampleCount = Math.min(channels[0].length, channels[1].length);
  const mono = new Float32Array(sampleCount);
  for (let sample = 0; sample < sampleCount; sample += 1) {
    mono[sample] = (channels[0][sample] + channels[1][sample]) / 2;
  }
  return [mono];
}

export function pcmRms(channels: Float32Array[]) {
  let energy = 0;
  let sampleCount = 0;
  for (const channel of channels) {
    for (const sample of channel) {
      energy += sample * sample;
      sampleCount += 1;
    }
  }
  return sampleCount > 0 ? Math.sqrt(energy / sampleCount) : 0;
}

function repairEffectivelySilentStereoChannel(samples: Float32Array[]) {
  if (samples.length !== 2 || samples[0].length < 128) return;

  const energy = [0, 0];
  for (let sample = 0; sample < samples[0].length; sample += 1) {
    energy[0] += samples[0][sample] * samples[0][sample];
    energy[1] += samples[1][sample] * samples[1][sample];
  }

  const quietChannel = energy[0] <= energy[1] ? 0 : 1;
  const activeChannel = quietChannel === 0 ? 1 : 0;
  const quietRms = Math.sqrt(energy[quietChannel] / samples[quietChannel].length);
  const activeRms = Math.sqrt(energy[activeChannel] / samples[activeChannel].length);
  if (activeRms >= 0.01 && quietRms <= 0.001 && energy[quietChannel] <= energy[activeChannel] * 0.0001) {
    samples[quietChannel].set(samples[activeChannel]);
  }
}
