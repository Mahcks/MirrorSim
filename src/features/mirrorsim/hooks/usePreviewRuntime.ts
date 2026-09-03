import { useCallback, useEffect, useRef, useState, type CSSProperties, type Dispatch, type SetStateAction } from "react";

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

import {
  PREVIEW_TELEMETRY_EVENT,
  SESSION_STATUS_EVENT,
} from "@/features/mirrorsim/constants";
import { fmtError, readBufferedEnd } from "@/features/mirrorsim/helpers";
import {
  getLivePlaybackCorrection,
  getLivePlaybackRecovery,
} from "@/features/mirrorsim/livePlayback";
import type { PreviewTelemetry, SessionSnapshot, VideoElementDiag } from "@/features/mirrorsim/types";
import {
  attachMockPreviewStream,
  clearRetainedPreviewFrame,
  initialPreviewStreamClientDiagnostics,
  mountPreviewSurface,
  type MockPreviewStreamStatus,
  type PreviewStreamClientDiagnostics,
} from "@/mockPreviewStream";
import {
  initialBonjourStatus,
  initialPairingStatus,
  PAIRING_STATUS_EVENT,
  initialPreviewDiagnostics,
  initialReceiverRuntime,
  PREVIEW_DIAGNOSTICS_EVENT,
  PREVIEW_STREAM_EVENT,
  RECEIVER_RUNTIME_EVENT,
  type PairingSnapshot,
  type BonjourStatusSnapshot,
  type PreviewDiagnosticsSnapshot,
  type PreviewStreamDescriptor,
  type ReceiverRuntimeSnapshot,
} from "@/receiverContract";

type PreviewPresetSurface = {
  catchupLeadSeconds: number;
  catchupTargetOffsetSeconds: number;
  imageRendering: CSSProperties["imageRendering"];
  filter?: string;
};

type UsePreviewRuntimeArgs = {
  previewPreset: PreviewPresetSurface;
  setCommandError: Dispatch<SetStateAction<string | null>>;
};

export type PreviewClientDiagnosticContext = {
  videoAvailabilityNotice: "sender-paused" | "possible-protected" | null;
  senderPaused: boolean;
  lastAudioReceivedAtMs: number | null;
  lastAudibleAudioAtMs: number | null;
};

export function usePreviewRuntime({ previewPreset, setCommandError }: UsePreviewRuntimeArgs) {
  const [initializing, setInitializing] = useState(true);
  const [session, setSession] = useState<SessionSnapshot>({
    status: "idle",
    captureCount: 0,
    deviceName: "Waiting for iPhone",
    currentDeviceId: null,
    currentDeviceModel: null,
    currentDeviceOsName: null,
    currentDeviceOsVersion: null,
    currentDeviceOsBuildVersion: null,
    currentDeviceSourceVersion: null,
    currentDeviceKey: null,
    currentDeviceNickname: null,
    currentDeviceKnown: false,
    currentDeviceTrusted: false,
    currentDeviceBlocked: false,
    currentDeviceBlockedReason: null,
    receiverId: null,
    receiverProtocolVersion: null,
    receiverCapabilities: [],
  });
  const [preview, setPreview] = useState<PreviewTelemetry>({
    frameNumber: 0,
    fps: 0,
    bitrateKbps: 0,
    latencyMs: 0,
    activity: 0,
  });
  const [previewStream, setPreviewStream] = useState<PreviewStreamDescriptor | null>(null);
  const [receiverRuntime, setReceiverRuntime] = useState<ReceiverRuntimeSnapshot>(initialReceiverRuntime);
  const [bonjourStatus, setBonjourStatus] = useState<BonjourStatusSnapshot>(initialBonjourStatus);
  const [pairing, setPairing] = useState<PairingSnapshot>(initialPairingStatus);
  const [previewDiag, setPreviewDiag] = useState<PreviewDiagnosticsSnapshot>(initialPreviewDiagnostics);
  const [previewClientDiag, setPreviewClientDiag] = useState<PreviewStreamClientDiagnostics>(
    initialPreviewStreamClientDiagnostics,
  );
  const [videoDiag, setVideoDiag] = useState<VideoElementDiag>({
    currentTime: 0,
    bufferedEnd: 0,
    readyState: 0,
    paused: true,
    videoWidth: 0,
    videoHeight: 0,
    totalVideoFrames: 0,
    droppedVideoFrames: 0,
    playbackRate: 1,
  });
  const [surfaceStatus, setSurfaceStatus] = useState<MockPreviewStreamStatus>("loading");
  const [surfaceError, setSurfaceError] = useState<string | null>(null);
  const [previewRetryNonce, setPreviewRetryNonce] = useState(0);
  const [videoRecoveryCount, setVideoRecoveryCount] = useState(0);
  const [videoEl, setVideoEl] = useState<HTMLVideoElement | null>(null);
  const [hasRetainedPreviewFrame, setHasRetainedPreviewFrame] = useState(false);
  const [documentVisible, setDocumentVisible] = useState(() => document.visibilityState !== "hidden");
  const persistentVideoRef = useRef<HTMLVideoElement | null>(null);
  const latestDecodedOutputCountRef = useRef(0);
  const playbackWatchdogRef = useRef({
    lastCurrentTime: 0,
    lastTotalVideoFrames: 0,
    lastMediaAppendCount: 0,
    lastDecodedOutputCount: 0,
    lastPresentedFrameCount: 0,
    lastBackendFrameNumber: 0,
    lastProgressAtMs: performance.now(),
    lastDecoderOutputAtMs: performance.now(),
    lastSegmentAtMs: 0,
    lastBackendFrameAtMs: 0,
    lastRecoveryAtMs: 0,
    wasDocumentHidden: false,
  });
  const previewClientReportRef = useRef({
    diagnostics: initialPreviewStreamClientDiagnostics,
    surfaceStatus: "loading" as MockPreviewStreamStatus,
    surfaceError: null as string | null,
    documentVisible: true,
  });
  const previewClientDiagnosticContextRef = useRef<PreviewClientDiagnosticContext>({
    videoAvailabilityNotice: null,
    senderPaused: false,
    lastAudioReceivedAtMs: null,
    lastAudibleAudioAtMs: null,
  });
  const isLive = session.status === "mirroring" || session.status === "recording";
  const previewAttachmentKey = previewStream === null
    ? null
    : JSON.stringify(previewStream);

  const setPreviewClientDiagnosticContext = useCallback((context: PreviewClientDiagnosticContext) => {
    previewClientDiagnosticContextRef.current = context;
  }, []);

  useEffect(() => {
    const handleVisibilityChange = () => setDocumentVisible(document.visibilityState !== "hidden");
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => document.removeEventListener("visibilitychange", handleVisibilityChange);
  }, []);

  const setVideoHost = useCallback((host: HTMLDivElement | null) => {
    if (!host) {
      return;
    }

    let video = persistentVideoRef.current;
    if (!video) {
      video = document.createElement("video");
      // AirPlay can expose a landscape media surface without the iPhone itself
      // rotating. Preserve the selected device frame and fit the full source;
      // the user can rotate the frame explicitly from the title bar.
      video.className = "h-full w-full object-contain";
      video.muted = true;
      video.playsInline = true;
      video.preload = "auto";
      persistentVideoRef.current = video;
      setVideoEl(video);
    }

    mountPreviewSurface(video, host);
  }, []);

  useEffect(() => {
    let alive = true;
    const unsubs: Array<() => void> = [];
    let telemetryTimeoutId: number | null = null;
    let runtimeTimeoutId: number | null = null;
    let diagnosticsTimeoutId: number | null = null;
    let pendingTelemetry: PreviewTelemetry | null = null;
    let pendingRuntime: ReceiverRuntimeSnapshot | null = null;
    let pendingDiagnostics: PreviewDiagnosticsSnapshot | null = null;
    const eventSeen = {
      session: false,
      preview: false,
      stream: false,
      diagnostics: false,
      runtime: false,
      pairing: false,
    };
    const keepUnsubscribe = (unsubscribe: () => void) => {
      if (alive) {
        unsubs.push(unsubscribe);
      } else {
        unsubscribe();
      }
    };

    void (async () => {
      try {
        keepUnsubscribe(
          await listen<SessionSnapshot>(SESSION_STATUS_EVENT, (event) => {
            if (alive) {
              eventSeen.session = true;
              setSession(event.payload);
            }
          }),
        );
        keepUnsubscribe(
          await listen<PreviewTelemetry>(PREVIEW_TELEMETRY_EVENT, (event) => {
            if (alive) {
              eventSeen.preview = true;
              pendingTelemetry = event.payload;
              if (telemetryTimeoutId === null) {
                telemetryTimeoutId = window.setTimeout(() => {
                  telemetryTimeoutId = null;
                  if (alive && pendingTelemetry) setPreview(pendingTelemetry);
                  pendingTelemetry = null;
                }, 150);
              }
            }
          }),
        );
        keepUnsubscribe(
          await listen<PreviewStreamDescriptor>(PREVIEW_STREAM_EVENT, (event) => {
            if (alive) {
              eventSeen.stream = true;
              setPreviewStream(event.payload);
            }
          }),
        );
        keepUnsubscribe(
          await listen<PreviewDiagnosticsSnapshot>(PREVIEW_DIAGNOSTICS_EVENT, (event) => {
            if (alive) {
              eventSeen.diagnostics = true;
              pendingDiagnostics = event.payload;
              if (diagnosticsTimeoutId === null) {
                diagnosticsTimeoutId = window.setTimeout(() => {
                  diagnosticsTimeoutId = null;
                  if (alive && pendingDiagnostics) setPreviewDiag(pendingDiagnostics);
                  pendingDiagnostics = null;
                }, 250);
              }
            }
          }),
        );
        keepUnsubscribe(
          await listen<ReceiverRuntimeSnapshot>(RECEIVER_RUNTIME_EVENT, (event) => {
            if (alive) {
              eventSeen.runtime = true;
              pendingRuntime = event.payload;
              if (runtimeTimeoutId === null) {
                runtimeTimeoutId = window.setTimeout(() => {
                  runtimeTimeoutId = null;
                  if (alive && pendingRuntime) setReceiverRuntime(pendingRuntime);
                  pendingRuntime = null;
                }, 250);
              }
            }
          }),
        );
        keepUnsubscribe(
          await listen<PairingSnapshot>(PAIRING_STATUS_EVENT, (event) => {
            if (alive) {
              eventSeen.pairing = true;
              setPairing(event.payload);
            }
          }),
        );

        const results = await Promise.allSettled([
          invoke<SessionSnapshot>("get_session_snapshot"),
          invoke<PreviewTelemetry>("get_preview_telemetry"),
          invoke<ReceiverRuntimeSnapshot>("refresh_receiver_readiness"),
          invoke<PreviewDiagnosticsSnapshot>("get_preview_diagnostics"),
          invoke<PreviewStreamDescriptor>("get_preview_stream_descriptor"),
          invoke<BonjourStatusSnapshot>("get_bonjour_status"),
          invoke<PairingSnapshot>("get_pairing_snapshot"),
        ]);

        if (alive) {
          const [snap, telemetry, runtime, diagnostics, stream, bonjour, initialPairing] = results;
          if (snap.status === "fulfilled" && !eventSeen.session) setSession(snap.value);
          if (telemetry.status === "fulfilled" && !eventSeen.preview) setPreview(telemetry.value);
          if (runtime.status === "fulfilled" && !eventSeen.runtime) setReceiverRuntime(runtime.value);
          if (diagnostics.status === "fulfilled" && !eventSeen.diagnostics) setPreviewDiag(diagnostics.value);
          if (stream.status === "fulfilled" && !eventSeen.stream) setPreviewStream(stream.value);
          if (bonjour.status === "fulfilled") setBonjourStatus(bonjour.value);
          if (initialPairing.status === "fulfilled" && !eventSeen.pairing) setPairing(initialPairing.value);

          const failures = results
            .filter((result): result is PromiseRejectedResult => result.status === "rejected")
            .map((result) => fmtError(result.reason));
          if (failures.length > 0) {
            setCommandError(`MirrorSim started with incomplete runtime state: ${failures.join("; ")}`);
          }
        }
      } catch (error) {
        if (alive) {
          setCommandError(fmtError(error));
        }
      } finally {
        if (alive) setInitializing(false);
      }
    })();

    return () => {
      alive = false;
      if (telemetryTimeoutId !== null) window.clearTimeout(telemetryTimeoutId);
      if (runtimeTimeoutId !== null) window.clearTimeout(runtimeTimeoutId);
      if (diagnosticsTimeoutId !== null) window.clearTimeout(diagnosticsTimeoutId);
      unsubs.forEach((unsubscribe) => unsubscribe());
    };
  }, [setCommandError]);

  useEffect(() => {
    setPreviewClientDiag(initialPreviewStreamClientDiagnostics);
    latestDecodedOutputCountRef.current = 0;
    setVideoDiag({
      currentTime: 0,
      bufferedEnd: 0,
      readyState: 0,
      paused: true,
      videoWidth: 0,
      videoHeight: 0,
      totalVideoFrames: 0,
      droppedVideoFrames: 0,
      playbackRate: 1,
    });
  }, [previewStream?.configGeneration, previewStream?.streamId]);

  useEffect(() => {
    playbackWatchdogRef.current = {
      lastCurrentTime: 0,
      lastTotalVideoFrames: 0,
      lastMediaAppendCount: 0,
      lastDecodedOutputCount: 0,
      lastPresentedFrameCount: 0,
      lastBackendFrameNumber: 0,
      lastProgressAtMs: performance.now(),
      lastDecoderOutputAtMs: performance.now(),
      lastSegmentAtMs: 0,
      lastBackendFrameAtMs: 0,
      lastRecoveryAtMs: 0,
      wasDocumentHidden: false,
    };
    setVideoRecoveryCount(0);
  }, [previewStream?.configGeneration, previewStream?.streamId]);

  useEffect(() => {
    if (!videoEl || !previewStream) {
      return;
    }

    return attachMockPreviewStream(videoEl, previewStream, {
      onStatusChange: (status) => {
        setSurfaceStatus(status);
        if (status !== "error") {
          setSurfaceError(null);
        }
      },
      onError: (message) => setSurfaceError(message),
      onDiagnosticsChange: (diagnostics) => {
        const decoderOutputAdvanced = diagnostics.decodedOutputCount > latestDecodedOutputCountRef.current;
        latestDecodedOutputCountRef.current = diagnostics.decodedOutputCount;
        setPreviewClientDiag(diagnostics);
        if (diagnostics.decodedOutputCount > 0) {
          setHasRetainedPreviewFrame(true);
        }
        if (decoderOutputAdvanced) {
          setSurfaceStatus((status) => status === "error" ? "ready" : status);
          setSurfaceError(null);
        }
      },
    });
  // Receiver warnings may re-emit an equivalent descriptor object. Key the
  // attachment by descriptor content so a no-op state refresh cannot tear down
  // the only live H.264 dependency chain.
  }, [previewAttachmentKey, previewRetryNonce, videoEl]);

  useEffect(() => {
    previewClientReportRef.current = {
      diagnostics: previewClientDiag,
      surfaceStatus,
      surfaceError,
      documentVisible,
    };
  }, [documentVisible, previewClientDiag, surfaceError, surfaceStatus]);

  useEffect(() => {
    if (!isLive) {
      return;
    }

    const report = () => {
      const latest = previewClientReportRef.current;
      const context = previewClientDiagnosticContextRef.current;
      const nowMs = performance.now();
      const ageMs = (timestampMs: number | null) => timestampMs === null
        ? null
        : Math.max(0, Math.round(nowMs - timestampMs));
      void invoke("report_preview_client_diagnostics", {
        diagnostics: {
          ...latest.diagnostics,
          surfaceStatus: latest.surfaceStatus,
          surfaceError: latest.surfaceError,
          documentVisible: latest.documentVisible,
          streamId: previewStream?.streamId ?? null,
          configGeneration: previewStream?.configGeneration ?? null,
          videoAvailabilityNotice: context.videoAvailabilityNotice,
          senderPaused: context.senderPaused,
          lastPixelProbeAgeMs: ageMs(latest.diagnostics.lastPixelProbeAtMs),
          lastAudioReceivedAgeMs: ageMs(context.lastAudioReceivedAtMs),
          lastAudibleAudioAgeMs: ageMs(context.lastAudibleAudioAtMs),
          reportedAt: Date.now(),
        },
      }).catch((error) => {
        console.warn("[MirrorSim preview] could not retain client diagnostics", error);
      });
    };

    report();
    const intervalId = window.setInterval(report, 2_000);
    return () => window.clearInterval(intervalId);
  }, [isLive, previewStream?.configGeneration, previewStream?.streamId]);

  useEffect(() => {
    if (!videoEl) {
      return;
    }

    const sync = () => {
      const quality = typeof videoEl.getVideoPlaybackQuality === "function" ? videoEl.getVideoPlaybackQuality() : null;
      setVideoDiag({
        currentTime: videoEl.currentTime,
        bufferedEnd: readBufferedEnd(videoEl),
        readyState: videoEl.readyState,
        paused: videoEl.paused,
        videoWidth: videoEl.videoWidth,
        videoHeight: videoEl.videoHeight,
        totalVideoFrames: quality?.totalVideoFrames ?? 0,
        droppedVideoFrames: quality?.droppedVideoFrames ?? 0,
        playbackRate: videoEl.playbackRate,
      });
    };

    sync();
    const intervalId = window.setInterval(sync, 500);
    return () => window.clearInterval(intervalId);
  }, [previewStream?.configGeneration, previewStream?.streamId, surfaceStatus, videoEl]);

  useEffect(() => {
    if (!videoEl || surfaceStatus !== "ready") {
      return;
    }

    if (isLive) {
      void videoEl.play().catch((error) => {
        if (previewClientDiag.playbackBackend === "webcodecs") {
          return;
        }
        setSurfaceError(fmtError(error));
        setSurfaceStatus("error");
      });
      return;
    }

    videoEl.pause();
    if (!videoEl.srcObject) {
      videoEl.currentTime = 0;
    }
  }, [isLive, previewClientDiag.playbackBackend, surfaceStatus, videoEl]);

  useEffect(() => {
    if ((session.status === "idle" || session.status === "discovering") && videoEl) {
      clearRetainedPreviewFrame(videoEl);
      setHasRetainedPreviewFrame(false);
    }
  }, [session.status, videoEl]);

  useEffect(() => {
    if (!videoEl || !isLive || surfaceStatus !== "ready") {
      if (videoEl && videoEl.playbackRate !== 1) {
        videoEl.playbackRate = 1;
      }
      return;
    }

    if (previewClientDiag.playbackBackend === "webcodecs") {
      // WebCodecs renders directly to the visible canvas. The video element is
      // only a recording bridge and has no live timeline to seek or accelerate.
      videoEl.playbackRate = 1;
      return;
    }

    const correction = getLivePlaybackCorrection({
      currentTime: videoDiag.currentTime,
      bufferedEnd: videoDiag.bufferedEnd,
      paused: videoDiag.paused,
      readyState: videoDiag.readyState,
      catchupLeadSeconds: previewPreset.catchupLeadSeconds,
      catchupTargetOffsetSeconds: previewPreset.catchupTargetOffsetSeconds,
    });
    if (Math.abs(videoEl.playbackRate - correction.playbackRate) > 0.01) {
      videoEl.playbackRate = correction.playbackRate;
    }

    if (correction.seekTime === null) {
      if (!correction.shouldPlay) {
        return;
      }
    } else {
      videoEl.currentTime = correction.seekTime;
    }

    void videoEl.play().catch((error) => {
      setSurfaceError(fmtError(error));
      setSurfaceStatus("error");
    });
  }, [isLive, previewClientDiag.playbackBackend, previewPreset.catchupLeadSeconds, previewPreset.catchupTargetOffsetSeconds, surfaceStatus, videoDiag, videoEl]);

  useEffect(() => {
    const watchdog = playbackWatchdogRef.current;
    const now = performance.now();

    if (!videoEl || !isLive || surfaceStatus !== "ready") {
      watchdog.lastProgressAtMs = now;
      watchdog.lastSegmentAtMs = 0;
      return;
    }

    if (!documentVisible) {
      watchdog.wasDocumentHidden = true;
      watchdog.lastProgressAtMs = now;
      watchdog.lastDecoderOutputAtMs = now;
      watchdog.lastSegmentAtMs = now;
      watchdog.lastCurrentTime = videoDiag.currentTime;
      watchdog.lastTotalVideoFrames = videoDiag.totalVideoFrames;
      watchdog.lastMediaAppendCount = previewClientDiag.mediaAppendCount;
      watchdog.lastDecodedOutputCount = previewClientDiag.decodedOutputCount;
      watchdog.lastPresentedFrameCount = previewClientDiag.presentedFrameCount;
      watchdog.lastBackendFrameNumber = preview.frameNumber;
      return;
    }

    if (watchdog.wasDocumentHidden) {
      watchdog.wasDocumentHidden = false;
      watchdog.lastProgressAtMs = now;
      watchdog.lastDecoderOutputAtMs = now;
      watchdog.lastSegmentAtMs = now;
      watchdog.lastCurrentTime = videoDiag.currentTime;
      watchdog.lastTotalVideoFrames = videoDiag.totalVideoFrames;
      watchdog.lastMediaAppendCount = previewClientDiag.mediaAppendCount;
      watchdog.lastDecodedOutputCount = previewClientDiag.decodedOutputCount;
      watchdog.lastPresentedFrameCount = previewClientDiag.presentedFrameCount;
      watchdog.lastBackendFrameNumber = preview.frameNumber;
      return;
    }

    const presentedFrameAdvanced = previewClientDiag.presentedFrameCount > watchdog.lastPresentedFrameCount;
    const playbackAdvanced = previewClientDiag.playbackBackend === "webcodecs"
      ? presentedFrameAdvanced
      : videoDiag.currentTime > watchdog.lastCurrentTime + 0.015
        || videoDiag.totalVideoFrames > watchdog.lastTotalVideoFrames;
    const decoderOutputAdvanced = previewClientDiag.decodedOutputCount > watchdog.lastDecodedOutputCount;
    const segmentsAdvanced = previewClientDiag.mediaAppendCount > watchdog.lastMediaAppendCount;
    const backendFramesAdvanced = preview.frameNumber > watchdog.lastBackendFrameNumber;

    if (playbackAdvanced) {
      watchdog.lastProgressAtMs = now;
    }
    if (segmentsAdvanced) {
      watchdog.lastSegmentAtMs = now;
    }
    if (decoderOutputAdvanced) {
      watchdog.lastDecoderOutputAtMs = now;
    }
    if (backendFramesAdvanced) {
      watchdog.lastBackendFrameAtMs = now;
    }

    watchdog.lastCurrentTime = videoDiag.currentTime;
    watchdog.lastTotalVideoFrames = videoDiag.totalVideoFrames;
    watchdog.lastMediaAppendCount = previewClientDiag.mediaAppendCount;
    watchdog.lastDecodedOutputCount = previewClientDiag.decodedOutputCount;
    watchdog.lastPresentedFrameCount = previewClientDiag.presentedFrameCount;
    watchdog.lastBackendFrameNumber = preview.frameNumber;

    const receivingSegments = now - watchdog.lastSegmentAtMs < 1_500
      || now - watchdog.lastBackendFrameAtMs < 1_500;
    if (
      previewClientDiag.playbackBackend === "webcodecs"
      && receivingSegments
      && previewClientDiag.mediaAppendCount > 0
      && now - watchdog.lastDecoderOutputAtMs > 3_000
    ) {
      setSurfaceError("The live decoder stopped producing frames. Reconnect Screen Mirroring to resume safely.");
      setSurfaceStatus("error");
      return;
    }
    if (
      previewClientDiag.playbackBackend === "webcodecs"
      && receivingSegments
      && decoderOutputAdvanced
      && now - watchdog.lastProgressAtMs > 6_000
    ) {
      setSurfaceError("The live video surface stopped presenting decoded frames. Reconnect Screen Mirroring to resume safely.");
      setSurfaceStatus("error");
      return;
    }

    const action = getLivePlaybackRecovery({
      receivingSegments,
      stalledForMs: now - watchdog.lastProgressAtMs,
    });

    if (action === "none") {
      return;
    }
    if (now - watchdog.lastRecoveryAtMs < 2_000) {
      return;
    }
    videoEl.playbackRate = 1;
    void videoEl.play().catch(() => {});
    watchdog.lastRecoveryAtMs = now;
    setVideoRecoveryCount((count) => count + 1);
  }, [
    documentVisible,
    isLive,
    previewClientDiag.mediaAppendCount,
    previewClientDiag.decodedOutputCount,
    previewClientDiag.presentedFrameCount,
    preview.frameNumber,
    previewPreset.catchupTargetOffsetSeconds,
    surfaceStatus,
    videoDiag.currentTime,
    videoDiag.totalVideoFrames,
    videoEl,
  ]);

  return {
    initializing,
    session,
    setSession,
    preview,
    previewStream,
    receiverRuntime,
    setReceiverRuntime,
    bonjourStatus,
    setBonjourStatus,
    pairing,
    setPairing,
    previewDiag,
    previewClientDiag,
    videoDiag,
    videoRecoveryCount,
    surfaceStatus,
    setSurfaceStatus,
    surfaceError,
    documentVisible,
    setPreviewClientDiagnosticContext,
    setSurfaceError,
    retryPreview: () => {
      setSurfaceError(null);
      setSurfaceStatus("loading");
      setPreviewRetryNonce((value) => value + 1);
    },
    videoEl,
    hasRetainedPreviewFrame,
    setVideoHost,
  };
}
