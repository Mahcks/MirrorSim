import { useEffect, useState, type CSSProperties, type Dispatch, type SetStateAction } from "react";

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

import {
  PREVIEW_TELEMETRY_EVENT,
  SESSION_STATUS_EVENT,
} from "@/features/mirrorsim/constants";
import { fmtError, readBufferedEnd } from "@/features/mirrorsim/helpers";
import type { PreviewTelemetry, SessionSnapshot, VideoElementDiag } from "@/features/mirrorsim/types";
import {
  attachMockPreviewStream,
  initialPreviewStreamClientDiagnostics,
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

export function usePreviewRuntime({ previewPreset, setCommandError }: UsePreviewRuntimeArgs) {
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
  });
  const [surfaceStatus, setSurfaceStatus] = useState<MockPreviewStreamStatus>("loading");
  const [surfaceError, setSurfaceError] = useState<string | null>(null);
  const [videoEl, setVideoEl] = useState<HTMLVideoElement | null>(null);
  const isLive = session.status === "mirroring" || session.status === "recording";

  useEffect(() => {
    let alive = true;
    const unsubs: Array<() => void> = [];

    void (async () => {
      try {
        unsubs.push(
          await listen<SessionSnapshot>(SESSION_STATUS_EVENT, (event) => {
            if (alive) {
              setSession(event.payload);
              setCommandError(null);
            }
          }),
        );
        unsubs.push(
          await listen<PreviewTelemetry>(PREVIEW_TELEMETRY_EVENT, (event) => {
            if (alive) {
              setPreview(event.payload);
            }
          }),
        );
        unsubs.push(
          await listen<PreviewStreamDescriptor>(PREVIEW_STREAM_EVENT, (event) => {
            if (alive) {
              setPreviewStream(event.payload);
            }
          }),
        );
        unsubs.push(
          await listen<PreviewDiagnosticsSnapshot>(PREVIEW_DIAGNOSTICS_EVENT, (event) => {
            if (alive) {
              setPreviewDiag(event.payload);
            }
          }),
        );
        unsubs.push(
          await listen<ReceiverRuntimeSnapshot>(RECEIVER_RUNTIME_EVENT, (event) => {
            if (alive) {
              setReceiverRuntime(event.payload);
            }
          }),
        );
        unsubs.push(
          await listen<PairingSnapshot>(PAIRING_STATUS_EVENT, (event) => {
            if (alive) {
              setPairing(event.payload);
            }
          }),
        );

        const [snap, telemetry, runtime, diagnostics, stream, bonjour, initialPairing] = await Promise.all([
          invoke<SessionSnapshot>("get_session_snapshot"),
          invoke<PreviewTelemetry>("get_preview_telemetry"),
          invoke<ReceiverRuntimeSnapshot>("refresh_receiver_readiness"),
          invoke<PreviewDiagnosticsSnapshot>("get_preview_diagnostics"),
          invoke<PreviewStreamDescriptor>("get_preview_stream_descriptor"),
          invoke<BonjourStatusSnapshot>("get_bonjour_status"),
          invoke<PairingSnapshot>("get_pairing_snapshot"),
        ]);

        if (alive) {
          setSession(snap);
          setPreview(telemetry);
          setReceiverRuntime(runtime);
          setPreviewDiag(diagnostics);
          setPreviewStream(stream);
          setBonjourStatus(bonjour);
          setPairing(initialPairing);
        }
      } catch (error) {
        if (alive) {
          setCommandError(fmtError(error));
        }
      }
    })();

    return () => {
      alive = false;
      unsubs.forEach((unsubscribe) => unsubscribe());
    };
  }, [setCommandError]);

  useEffect(() => {
    setPreviewClientDiag(initialPreviewStreamClientDiagnostics);
    setVideoDiag({
      currentTime: 0,
      bufferedEnd: 0,
      readyState: 0,
      paused: true,
      videoWidth: 0,
      videoHeight: 0,
      totalVideoFrames: 0,
      droppedVideoFrames: 0,
    });
  }, [previewStream?.streamId]);

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
      onDiagnosticsChange: (diagnostics) => setPreviewClientDiag(diagnostics),
    });
  }, [previewStream, videoEl]);

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
      });
    };

    sync();
    const intervalId = window.setInterval(sync, 250);
    return () => window.clearInterval(intervalId);
  }, [previewStream?.streamId, surfaceStatus, videoEl]);

  useEffect(() => {
    if (!videoEl || surfaceStatus !== "ready") {
      return;
    }

    if (isLive) {
      void videoEl.play().catch((error) => {
        setSurfaceError(fmtError(error));
        setSurfaceStatus("error");
      });
      return;
    }

    videoEl.pause();
    videoEl.currentTime = 0;
  }, [isLive, surfaceStatus, videoEl]);

  useEffect(() => {
    if (!videoEl || !isLive || surfaceStatus !== "ready") {
      return;
    }

    const lead = videoDiag.bufferedEnd - videoDiag.currentTime;
    if (!(!videoDiag.paused && lead > previewPreset.catchupLeadSeconds && videoDiag.readyState >= 2)) {
      return;
    }

    const edge = Math.max(0, videoDiag.bufferedEnd - previewPreset.catchupTargetOffsetSeconds);
    if (edge <= videoDiag.currentTime + 0.2) {
      return;
    }

    videoEl.currentTime = edge;
    void videoEl.play().catch((error) => {
      setSurfaceError(fmtError(error));
      setSurfaceStatus("error");
    });
  }, [isLive, previewPreset.catchupLeadSeconds, previewPreset.catchupTargetOffsetSeconds, surfaceStatus, videoDiag, videoEl]);

  return {
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
    surfaceStatus,
    setSurfaceStatus,
    surfaceError,
    setSurfaceError,
    videoEl,
    setVideoEl,
  };
}
