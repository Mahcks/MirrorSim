import { useCallback, useEffect, useRef, useState } from "react";

import { invoke } from "@tauri-apps/api/core";

import { effectivePlaybackGain } from "../audioVolume";
import { decodePcm16Base64, mixPcmChannelsToMono, pcmRms } from "../pcmAudio";
import type { AudioChannelMode, PreviewAudioFrame } from "../types";

type AudioGraph = {
  context: AudioContext;
  playbackGain: GainNode;
  recordingGain: GainNode;
  recordingDestination: MediaStreamAudioDestinationNode;
};

// Windows' AAC encoder (used for MP4 recordings) drops digitally silent input
// instead of encoding it. The MP4 then has no gap where the silence was, so
// every later sound plays early and the audio track ends short. Mixing noise of
// two 16-bit steps (about -84 dBFS, inaudible) into the recording path keeps the
// encoder producing frames; one step was enough in testing, two leaves a margin.
const RECORDING_NOISE_FLOOR_AMPLITUDE = 2 / 32768;

function connectRecordingNoiseFloor(context: AudioContext, destination: AudioNode) {
  const noise = context.createBuffer(2, context.sampleRate, context.sampleRate);
  for (let channel = 0; channel < noise.numberOfChannels; channel += 1) {
    const samples = noise.getChannelData(channel);
    for (let index = 0; index < samples.length; index += 1) {
      samples[index] = (Math.random() * 2 - 1) * RECORDING_NOISE_FLOOR_AMPLITUDE;
    }
  }
  const source = context.createBufferSource();
  source.buffer = noise;
  source.loop = true;
  source.connect(destination);
  source.start();
}

type UsePreviewAudioArgs = {
  available: boolean;
  isLive: boolean;
  muted: boolean;
  volume: number;
  followIphoneVolume: boolean;
  senderVolumeDb: number | null;
  channelMode: AudioChannelMode;
};

export function usePreviewAudio({
  available,
  isLive,
  muted,
  volume,
  followIphoneVolume,
  senderVolumeDb,
  channelMode,
}: UsePreviewAudioArgs) {
  const graphRef = useRef<AudioGraph | null>(null);
  const effectiveVolume = effectivePlaybackGain({
    muted,
    masterVolume: volume,
    followIphoneVolume,
    senderVolumeDb,
  });
  const initialPlaybackGainRef = useRef(effectiveVolume);
  initialPlaybackGainRef.current = effectiveVolume;
  const nextPlayTimeRef = useRef(0);
  const lastPtsRef = useRef<number | null>(null);
  const lastAudioActivityPublishAtRef = useRef(0);
  const lastAudibleAudioPublishAtRef = useRef(0);
  const scheduledSourcesRef = useRef(new Set<AudioBufferSourceNode>());
  const [recordingAudioTrack, setRecordingAudioTrack] = useState<MediaStreamTrack | null>(null);
  const [audioState, setAudioState] = useState<"unavailable" | "suspended" | "ready" | "playing" | "error">("unavailable");
  const [audioError, setAudioError] = useState<string | null>(null);
  const [lastAudioReceivedAtMs, setLastAudioReceivedAtMs] = useState<number | null>(null);
  const [lastAudibleAudioAtMs, setLastAudibleAudioAtMs] = useState<number | null>(null);

  const stopScheduledSources = useCallback(() => {
    for (const source of scheduledSourcesRef.current) {
      try {
        source.stop();
      } catch {
        // already stopped
      }
    }
    scheduledSourcesRef.current.clear();
  }, []);

  const ensureGraph = useCallback(() => {
    if (graphRef.current) {
      return graphRef.current;
    }

    const context = new AudioContext({ latencyHint: "interactive" });
    const playbackGain = context.createGain();
    const recordingGain = context.createGain();
    const recordingDestination = context.createMediaStreamDestination();
    playbackGain.connect(context.destination);
    recordingGain.connect(recordingDestination);
    playbackGain.gain.value = initialPlaybackGainRef.current;
    recordingGain.gain.value = 1;
    connectRecordingNoiseFloor(context, recordingDestination);

    const graph = { context, playbackGain, recordingGain, recordingDestination };
    graphRef.current = graph;
    setRecordingAudioTrack(recordingDestination.stream.getAudioTracks()[0] ?? null);
    setAudioState(context.state === "running" ? "ready" : "suspended");
    return graph;
  }, []);

  const primeAudio = useCallback(async () => {
    try {
      const graph = ensureGraph();
      if (graph.context.state === "suspended") {
        await graph.context.resume();
      }
      setAudioError(null);
      setAudioState("ready");
    } catch (error) {
      setAudioError(error instanceof Error ? error.message : String(error));
      setAudioState("error");
    }
  }, [ensureGraph]);

  // A suspended AudioContext gives the recording track no samples, and the
  // WebM muxer then holds back every video frame, so only record audio when
  // the context is actually running.
  const ensureRecordingAudio = useCallback(async () => {
    await primeAudio();
    return graphRef.current?.context.state === "running";
  }, [primeAudio]);

  useEffect(() => {
    const graph = graphRef.current;
    if (!graph) return;
    graph.playbackGain.gain.setTargetAtTime(effectiveVolume, graph.context.currentTime, 0.015);
  }, [effectiveVolume]);

  useEffect(() => {
    if (!available) {
      setAudioState("unavailable");
      return;
    }

    const graph = ensureGraph();
    setAudioState(graph.context.state === "running" ? "ready" : "suspended");
  }, [available, ensureGraph]);

  useEffect(() => {
    if (!available || !isLive) {
      nextPlayTimeRef.current = 0;
      lastPtsRef.current = null;
      lastAudioActivityPublishAtRef.current = 0;
      lastAudibleAudioPublishAtRef.current = 0;
      setLastAudioReceivedAtMs(null);
      setLastAudibleAudioAtMs(null);
      stopScheduledSources();
      return;
    }

    let cancelled = false;
    let timerId: number | null = null;
    const poll = async () => {
      try {
        const frames = await invoke<PreviewAudioFrame[]>("take_preview_audio_frames");
        if (cancelled) return;
        const graph = ensureGraph();
        const framesReceivedAtMs = performance.now();
        if (frames.length > 0 && framesReceivedAtMs - lastAudioActivityPublishAtRef.current >= 250) {
          lastAudioActivityPublishAtRef.current = framesReceivedAtMs;
          setLastAudioReceivedAtMs(framesReceivedAtMs);
        }

        let scheduledFrame = false;
        let audibleFrame = false;
        for (const frame of frames) {
          if (frame.bitsPerSample !== 16 || frame.channels < 1 || frame.channels > 2) {
            continue;
          }
          const decodedChannels = decodePcm16Base64(frame.payloadBase64, frame.channels);
          audibleFrame ||= pcmRms(decodedChannels) >= 0.002;
          if (graph.context.state !== "running") {
            continue;
          }
          const outputChannels = channelMode === "mono"
            ? mixPcmChannelsToMono(decodedChannels)
            : decodedChannels;
          const sampleCount = outputChannels[0]?.length ?? 0;
          if (sampleCount <= 0) continue;

          const buffer = graph.context.createBuffer(outputChannels.length, sampleCount, frame.sampleRate);
          for (let channel = 0; channel < outputChannels.length; channel += 1) {
            buffer.getChannelData(channel).set(outputChannels[channel]);
          }

          const now = graph.context.currentTime;
          if (lastPtsRef.current !== null && (frame.pts <= lastPtsRef.current || frame.pts - lastPtsRef.current > 1_000_000)) {
            stopScheduledSources();
            nextPlayTimeRef.current = now + 0.045;
          }
          lastPtsRef.current = frame.pts;
          if (nextPlayTimeRef.current > now + 0.5) {
            stopScheduledSources();
            nextPlayTimeRef.current = now + 0.045;
          } else if (nextPlayTimeRef.current < now) {
            nextPlayTimeRef.current = now + 0.045;
          }
          const source = graph.context.createBufferSource();
          source.buffer = buffer;
          source.connect(graph.playbackGain);
          source.connect(graph.recordingGain);
          scheduledSourcesRef.current.add(source);
          source.addEventListener("ended", () => scheduledSourcesRef.current.delete(source), { once: true });
          source.start(nextPlayTimeRef.current);
          nextPlayTimeRef.current += buffer.duration;
          scheduledFrame = true;
        }

        if (audibleFrame && framesReceivedAtMs - lastAudibleAudioPublishAtRef.current >= 250) {
          lastAudibleAudioPublishAtRef.current = framesReceivedAtMs;
          setLastAudibleAudioAtMs(framesReceivedAtMs);
        }
        if (scheduledFrame) {
          setAudioState("playing");
          setAudioError(null);
        } else if (graph.context.state !== "running") {
          setAudioState("suspended");
        }
      } catch (error) {
        if (!cancelled) {
          setAudioError(error instanceof Error ? error.message : String(error));
          setAudioState("error");
        }
      } finally {
        if (!cancelled) {
          timerId = window.setTimeout(poll, 45);
        }
      }
    };

    void poll();
    return () => {
      cancelled = true;
      if (timerId !== null) window.clearTimeout(timerId);
    };
  }, [available, channelMode, ensureGraph, isLive, stopScheduledSources]);

  useEffect(() => () => {
    stopScheduledSources();
    void graphRef.current?.context.close();
    graphRef.current = null;
  }, [stopScheduledSources]);

  return {
    audioState,
    audioError,
    effectiveVolume,
    lastAudioReceivedAtMs,
    lastAudibleAudioAtMs,
    primeAudio,
    ensureRecordingAudio,
    recordingAudioTrack,
  };
}
