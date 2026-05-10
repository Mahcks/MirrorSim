import type { CSSProperties } from "react";
import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  attachMockPreviewStream,
  initialPreviewStreamClientDiagnostics,
  type MockPreviewStreamStatus,
  type PreviewStreamClientDiagnostics,
} from "./mockPreviewStream";
import {
  initialPreviewDiagnostics,
  initialReceiverRuntime,
  PREVIEW_DIAGNOSTICS_EVENT,
  PREVIEW_STREAM_EVENT,
  RECEIVER_RUNTIME_EVENT,
  type PreviewDiagnosticsSnapshot,
  type PreviewStreamDescriptor,
  type ReceiverRuntimeSnapshot,
} from "./receiverContract";
import "./App.css";

const scaleSteps = [75, 85, 100] as const;
const SESSION_STATUS_EVENT = "session-status";
const PREVIEW_TELEMETRY_EVENT = "preview-telemetry";

type Orientation = "portrait" | "landscape";
type GlyphName = "home" | "camera" | "rotate" | "record" | "scale" | "debug";
type SessionState = "idle" | "discovering" | "connecting" | "mirroring" | "recording";
type SessionCommand =
  | "get_session_snapshot"
  | "get_preview_telemetry"
  | "get_preview_stream_descriptor"
  | "get_preview_init_segment"
  | "take_preview_media_segment"
  | "get_preview_diagnostics"
  | "get_receiver_runtime"
  | "start_session"
  | "stop_session"
  | "take_screenshot"
  | "start_recording"
  | "stop_recording";

type SessionSnapshot = {
  status: SessionState;
  captureCount: number;
  deviceName: string;
};

type PreviewTelemetry = {
  frameNumber: number;
  fps: number;
  bitrateKbps: number;
  latencyMs: number;
  activity: number;
};

type VideoElementDiagnostics = {
  currentTime: number;
  bufferedEnd: number;
  readyState: number;
  paused: boolean;
  totalVideoFrames: number;
  droppedVideoFrames: number;
};

type PreviewSurfaceTone = "inactive" | "live" | "warning";

const sessionOrder: SessionState[] = ["idle", "discovering", "connecting", "mirroring", "recording"];

const sessionLabels: Record<SessionState, string> = {
  idle: "Idle",
  discovering: "Discovering",
  connecting: "Connecting",
  mirroring: "Mirroring",
  recording: "Recording",
};

const sessionDescriptions: Record<SessionState, string> = {
  idle: "Ready to discover a nearby iPhone and start a simulated session.",
  discovering: "Scanning for Bonjour and AirPlay endpoints on the local network.",
  connecting: "Receiver connected. Waiting for the first video frame and keyframe metadata from the sender.",
  mirroring: "Mock video frames are live and ready for control actions.",
  recording: "Capturing the simulated stream while the session remains interactive.",
};

const sessionActions: Record<SessionState, string> = {
  idle: "Discover device",
  discovering: "Cancel discovery",
  connecting: "Cancel session",
  mirroring: "Stop session",
  recording: "Stop recording",
};

const initialSnapshot: SessionSnapshot = {
  status: "idle",
  captureCount: 0,
  deviceName: "iPhone 15 Pro",
};

const initialPreview: PreviewTelemetry = {
  frameNumber: 0,
  fps: 0,
  bitrateKbps: 0,
  latencyMs: 0,
  activity: 0,
};

const initialVideoElementDiagnostics: VideoElementDiagnostics = {
  currentTime: 0,
  bufferedEnd: 0,
  readyState: 0,
  paused: true,
  totalVideoFrames: 0,
  droppedVideoFrames: 0,
};

function formatCommandError(error: unknown) {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

function formatNullableNumber(value: number | null) {
  return value === null ? "-" : String(value);
}

function formatSampleRange(start: number | null, end: number | null) {
  if (start === null || end === null) {
    return "-";
  }

  return `${start}-${end}`;
}

function readBufferedEnd(videoElement: HTMLVideoElement) {
  try {
    const { buffered } = videoElement;
    if (buffered.length === 0) {
      return 0;
    }

    return buffered.end(buffered.length - 1);
  } catch {
    return 0;
  }
}

async function invokeSessionCommand(command: SessionCommand) {
  return invoke(command);
}

function Glyph({ name }: { name: GlyphName }) {
  switch (name) {
    case "home":
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M4 11.5 12 5l8 6.5" />
          <path d="M7.5 10.5V19h9v-8.5" />
        </svg>
      );
    case "camera":
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M4 8.5h3l1.4-2h7.2l1.4 2H20v10H4z" />
          <circle cx="12" cy="13.5" r="3.5" />
        </svg>
      );
    case "rotate":
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M16.5 7H20V3.5" />
          <path d="M19.5 7.5A8 8 0 1 0 20 12" />
        </svg>
      );
    case "record":
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <rect x="4" y="5" width="16" height="14" rx="3" />
          <circle cx="12" cy="12" r="3.75" />
        </svg>
      );
    case "scale":
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M5 9V5h4" />
          <path d="M19 9V5h-4" />
          <path d="M5 15v4h4" />
          <path d="M19 15v4h-4" />
        </svg>
      );
    case "debug":
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M5 6.5h14v11H5z" />
          <path d="M9 10h6" />
          <path d="M9 14h3" />
          <path d="M8 3.5v3" />
          <path d="M16 3.5v3" />
        </svg>
      );
  }
}

function App() {
  const [orientation, setOrientation] = useState<Orientation>("portrait");
  const [scale, setScale] = useState<(typeof scaleSteps)[number]>(100);
  const [session, setSession] = useState<SessionSnapshot>(initialSnapshot);
  const [preview, setPreview] = useState<PreviewTelemetry>(initialPreview);
  const [previewStream, setPreviewStream] = useState<PreviewStreamDescriptor | null>(null);
  const [receiverRuntime, setReceiverRuntime] = useState<ReceiverRuntimeSnapshot>(initialReceiverRuntime);
  const [previewDiagnostics, setPreviewDiagnostics] = useState<PreviewDiagnosticsSnapshot>(initialPreviewDiagnostics);
  const [previewClientDiagnostics, setPreviewClientDiagnostics] =
    useState<PreviewStreamClientDiagnostics>(initialPreviewStreamClientDiagnostics);
  const [videoDiagnostics, setVideoDiagnostics] = useState<VideoElementDiagnostics>(initialVideoElementDiagnostics);
  const [previewSurfaceStatus, setPreviewSurfaceStatus] = useState<MockPreviewStreamStatus>("loading");
  const [previewSurfaceError, setPreviewSurfaceError] = useState<string | null>(null);
  const [backdropMode, setBackdropMode] = useState<"clean" | "stage">("clean");
  const [debugMenuOpen, setDebugMenuOpen] = useState(true);
  const [commandPending, setCommandPending] = useState(false);
  const [commandError, setCommandError] = useState<string | null>(null);
  const previewVideoRef = useRef<HTMLVideoElement | null>(null);

  const sessionState = session.status;
  const shellTitle = orientation === "portrait" ? `${session.deviceName} - iOS 17.2` : `${session.deviceName} - Landscape`;
  const deviceMetrics = orientation === "portrait" ? "393 x 852 pt" : "852 x 393 pt";
  const sessionIndex = sessionOrder.indexOf(sessionState);
  const sessionProgress = `${((sessionIndex / (sessionOrder.length - 1)) * 100).toFixed(0)}%`;
  const canCapture = sessionState === "mirroring" || sessionState === "recording";
  const canRecord = sessionState === "mirroring" || sessionState === "recording";
  const previewIsLive = sessionState === "mirroring" || sessionState === "recording";
  const previewSegmentCount = previewStream?.mediaSegmentPaths.length ?? 0;
  const previewSurfaceTone: PreviewSurfaceTone =
    previewSurfaceStatus === "error" || previewSurfaceStatus === "unsupported"
      ? "warning"
      : previewIsLive && previewSurfaceStatus === "ready"
        ? "live"
        : "inactive";
  const previewSurfaceLabel =
    previewSurfaceStatus === "ready"
      ? `${receiverRuntime.transport} transport ${receiverRuntime.state}`
      : previewSurfaceStatus === "loading"
        ? receiverRuntime.transport === "airplayserver"
          ? "Waiting for first video frame"
          : "Loading receiver preview"
        : previewSurfaceStatus === "unsupported"
          ? "MediaSource unsupported"
          : "Fixture stream failed";
  const previewTransportCopy =
    previewSurfaceStatus === "ready"
      ? previewIsLive
        ? receiverRuntime.transport === "airplayserver"
          ? `Appending ${receiverRuntime.queuedSegments} queued live fragments from the AirPlayServer adapter while Frame ${preview.frameNumber} tracks live receiver telemetry.`
          : `Appending ${previewSegmentCount} queued ${receiverRuntime.transport} fragments through MediaSource while Frame ${preview.frameNumber} tracks the mock transport telemetry.`
        : `Receiver transport is primed with ${receiverRuntime.queuedSegments} queued fragments and waiting for live mirroring.`
      : previewSurfaceError ?? receiverRuntime.lastError ?? "Preparing the receiver-backed preview transport inside the shell.";
  const bufferedAhead = Math.max(0, videoDiagnostics.bufferedEnd - videoDiagnostics.currentTime);

  useEffect(() => {
    let isMounted = true;
    const unlistenCallbacks: Array<() => void> = [];

    void (async () => {
      try {
        const unlistenSession = await listen<SessionSnapshot>(SESSION_STATUS_EVENT, (event) => {
          if (!isMounted) {
            return;
          }

          setSession(event.payload);
          setCommandError(null);
        });
        unlistenCallbacks.push(unlistenSession);

        const unlistenPreview = await listen<PreviewTelemetry>(PREVIEW_TELEMETRY_EVENT, (event) => {
          if (!isMounted) {
            return;
          }

          setPreview(event.payload);
        });
        unlistenCallbacks.push(unlistenPreview);

        const unlistenPreviewStream = await listen<PreviewStreamDescriptor>(PREVIEW_STREAM_EVENT, (event) => {
          if (!isMounted) {
            return;
          }

          setPreviewStream(event.payload);
        });
        unlistenCallbacks.push(unlistenPreviewStream);

        const unlistenPreviewDiagnostics = await listen<PreviewDiagnosticsSnapshot>(
          PREVIEW_DIAGNOSTICS_EVENT,
          (event) => {
            if (!isMounted) {
              return;
            }

            setPreviewDiagnostics(event.payload);
          },
        );
        unlistenCallbacks.push(unlistenPreviewDiagnostics);

        const unlistenReceiverRuntime = await listen<ReceiverRuntimeSnapshot>(RECEIVER_RUNTIME_EVENT, (event) => {
          if (!isMounted) {
            return;
          }

          setReceiverRuntime(event.payload);
        });
        unlistenCallbacks.push(unlistenReceiverRuntime);

        const [snapshot, previewTelemetry, receiverSnapshot, diagnosticsSnapshot, streamDescriptor] = await Promise.all([
          invokeSessionCommand("get_session_snapshot") as Promise<SessionSnapshot>,
          invokeSessionCommand("get_preview_telemetry") as Promise<PreviewTelemetry>,
          invokeSessionCommand("get_receiver_runtime") as Promise<ReceiverRuntimeSnapshot>,
          invokeSessionCommand("get_preview_diagnostics") as Promise<PreviewDiagnosticsSnapshot>,
          invokeSessionCommand("get_preview_stream_descriptor") as Promise<PreviewStreamDescriptor>,
        ]);

        if (isMounted) {
          setSession(snapshot);
          setPreview(previewTelemetry);
          setReceiverRuntime(receiverSnapshot);
          setPreviewDiagnostics(diagnosticsSnapshot);
          setPreviewStream(streamDescriptor);
        }
      } catch (error) {
        if (isMounted) {
          setCommandError(formatCommandError(error));
        }
      }
    })();

    return () => {
      isMounted = false;
      unlistenCallbacks.forEach((callback) => callback());
    };
  }, []);

  useEffect(() => {
    setPreviewClientDiagnostics(initialPreviewStreamClientDiagnostics);
    setVideoDiagnostics(initialVideoElementDiagnostics);
  }, [previewStream?.streamId]);

  useEffect(() => {
    const videoElement = previewVideoRef.current;

    if (!videoElement || !previewStream) {
      return;
    }

    return attachMockPreviewStream(videoElement, previewStream, {
      onStatusChange: (status) => {
        setPreviewSurfaceStatus(status);
        if (status !== "error") {
          setPreviewSurfaceError(null);
        }
      },
      onError: (message) => {
        setPreviewSurfaceError(message);
      },
      onDiagnosticsChange: (diagnostics) => {
        setPreviewClientDiagnostics(diagnostics);
      },
    });
  }, [previewStream]);

  useEffect(() => {
    const videoElement = previewVideoRef.current;

    if (!videoElement) {
      return;
    }

    const syncDiagnostics = () => {
      const quality =
        typeof videoElement.getVideoPlaybackQuality === "function"
          ? videoElement.getVideoPlaybackQuality()
          : null;

      setVideoDiagnostics({
        currentTime: videoElement.currentTime,
        bufferedEnd: readBufferedEnd(videoElement),
        readyState: videoElement.readyState,
        paused: videoElement.paused,
        totalVideoFrames: quality?.totalVideoFrames ?? 0,
        droppedVideoFrames: quality?.droppedVideoFrames ?? 0,
      });
    };

    syncDiagnostics();
    const intervalId = window.setInterval(syncDiagnostics, 250);

    return () => {
      window.clearInterval(intervalId);
    };
  }, [previewStream?.streamId, previewSurfaceStatus]);

  useEffect(() => {
    const videoElement = previewVideoRef.current;

    if (!videoElement || previewSurfaceStatus !== "ready") {
      return;
    }

    if (previewIsLive) {
      void videoElement.play().catch((error) => {
        setPreviewSurfaceError(formatCommandError(error));
        setPreviewSurfaceStatus("error");
      });
      return;
    }

    videoElement.pause();
    videoElement.currentTime = 0;
  }, [previewIsLive, previewSurfaceStatus]);

  useEffect(() => {
    const videoElement = previewVideoRef.current;

    if (!videoElement || !previewIsLive || previewSurfaceStatus !== "ready") {
      return;
    }

    const bufferedLead = videoDiagnostics.bufferedEnd - videoDiagnostics.currentTime;
    const looksStalled = !videoDiagnostics.paused && bufferedLead > 0.75 && videoDiagnostics.readyState >= 2;

    if (!looksStalled) {
      return;
    }

    const liveEdge = Math.max(0, videoDiagnostics.bufferedEnd - 0.12);
    if (liveEdge <= videoDiagnostics.currentTime + 0.2) {
      return;
    }

    videoElement.currentTime = liveEdge;
    void videoElement.play().catch((error) => {
      setPreviewSurfaceError(formatCommandError(error));
      setPreviewSurfaceStatus("error");
    });
  }, [previewIsLive, previewSurfaceStatus, videoDiagnostics]);

  async function runSessionCommand(command: SessionCommand) {
    setCommandPending(true);
    setCommandError(null);

    try {
      const snapshot = (await invokeSessionCommand(command)) as SessionSnapshot;
      setSession(snapshot);
    } catch (error) {
      setCommandError(formatCommandError(error));
    } finally {
      setCommandPending(false);
    }
  }

  function handleCapture() {
    if (!canCapture) {
      return;
    }

    void runSessionCommand("take_screenshot");
  }

  function handleRecordingToggle() {
    if (!canRecord) {
      return;
    }

    void runSessionCommand(sessionState === "recording" ? "stop_recording" : "start_recording");
  }

  function handlePrimaryAction() {
    if (sessionState === "idle") {
      void runSessionCommand("start_session");
      return;
    }

    if (sessionState === "recording") {
      void runSessionCommand("stop_recording");
      return;
    }

    void runSessionCommand("stop_session");
  }

  return (
    <main className={`sim-shell backdrop-${backdropMode}`}>
      <section className="simulator-chrome">
        <div className="chrome-row chrome-row-title">
          <div className="chrome-drag-region">
            <h1>{shellTitle}</h1>
          </div>
          <div className="chrome-status">{deviceMetrics}</div>
        </div>

        <div className="chrome-toolbar">
          <button
            type="button"
            className={`toolbar-primary-action toolbar-primary-action-${sessionState}`}
            onClick={handlePrimaryAction}
            disabled={commandPending}
          >
            {commandPending ? "Working..." : sessionActions[sessionState]}
          </button>
          <button
            type="button"
            className={`toolbar-button ${sessionState === "idle" ? "toolbar-button-disabled" : ""}`}
            aria-label="Reset session"
            onClick={() => void runSessionCommand("stop_session")}
            disabled={sessionState === "idle" || commandPending}
          >
            <Glyph name="home" />
          </button>
          <button
            type="button"
            className={`toolbar-button ${canCapture ? "" : "toolbar-button-disabled"}`}
            aria-label="Take screenshot"
            onClick={handleCapture}
            disabled={!canCapture || commandPending}
          >
            <Glyph name="camera" />
          </button>
          <button
            type="button"
            className={`toolbar-button ${sessionState === "recording" ? "active-record" : ""} ${canRecord ? "" : "toolbar-button-disabled"}`}
            aria-label="Toggle recording"
            onClick={handleRecordingToggle}
            disabled={!canRecord || commandPending}
          >
            <Glyph name="record" />
          </button>
          <button
            type="button"
            className="toolbar-button"
            aria-label="Rotate device"
            onClick={() => setOrientation((value) => (value === "portrait" ? "landscape" : "portrait"))}
          >
            <Glyph name="rotate" />
          </button>
          <button
            type="button"
            className={`toolbar-button ${backdropMode === "clean" ? "active-mode" : ""}`}
            aria-label="Toggle backdrop mode"
            onClick={() => setBackdropMode((value) => (value === "clean" ? "stage" : "clean"))}
          >
            <Glyph name="scale" />
          </button>
          <button
            type="button"
            className={`toolbar-button ${debugMenuOpen ? "active-mode" : ""}`}
            aria-label="Toggle debug console"
            onClick={() => setDebugMenuOpen((value) => !value)}
          >
            <Glyph name="debug" />
          </button>
        </div>
      </section>

      <section className="device-stage-shell">
        <div className="ambient-grid" />
        <div className="device-stage-copy">
          <span>Simulator shell</span>
          <p>Toolbar first, device centered, media surface ready for a real stream.</p>
        </div>

        <div
          className={`device-scaler ${orientation}`}
          style={{ "--device-scale": `${scale / 100}` } as CSSProperties}
        >
          <div className={`device-frame ${orientation}`}>
            <div className="device-bezel">
              <div className="device-island" />
              <div className={`device-screen session-screen session-${sessionState}`}>
                <div className={`mirror-preview mirror-preview-${previewSurfaceTone}`}>
                  <div className={`preview-video-shell preview-video-shell-${previewSurfaceTone}`}>
                    <video ref={previewVideoRef} className="preview-video" muted playsInline />
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      <section className={`debug-console ${debugMenuOpen ? "debug-console-open" : "debug-console-closed"}`}>
        <div className="debug-console-header">
          <div>
            <span className="debug-console-kicker">Runtime debug</span>
            <h2>Mirror Console</h2>
          </div>
          <button type="button" className="debug-console-toggle" onClick={() => setDebugMenuOpen((value) => !value)}>
            {debugMenuOpen ? "Hide panel" : "Show panel"}
          </button>
        </div>

        <div className="debug-console-summary">
          <span>{sessionLabels[sessionState]}</span>
          <span>{previewSurfaceLabel}</span>
          <span>{preview.fps} FPS</span>
          <span>{preview.latencyMs} ms</span>
          <span>{(preview.bitrateKbps / 1000).toFixed(1)} Mbps</span>
          <span>{previewIsLive ? "Live mirror visible" : "Waiting for stream"}</span>
        </div>

        {debugMenuOpen ? (
          <div className="debug-console-grid">
            <div className="debug-console-card debug-console-card-wide">
              <span className="diagnostics-label">Session</span>
              <strong>{sessionState === "idle" ? "No active stream" : sessionState === "recording" ? "Recording active" : "Live device surface"}</strong>
              <span>{sessionState === "idle" ? "Start discovery to stage a session." : previewTransportCopy}</span>
              <span>{commandError ?? sessionDescriptions[sessionState]}</span>
            </div>

            <div className="debug-console-card">
              <span className="diagnostics-label">State</span>
              <strong>{sessionProgress}</strong>
              <span>Shots {session.captureCount}</span>
              <span>Mode {sessionState === "recording" ? "REC" : orientation === "portrait" ? "Portrait" : "Landscape"}</span>
              <span>Frames {preview.frameNumber}</span>
            </div>

            <div className="debug-console-card">
              <span className="diagnostics-label">Receiver</span>
              <strong>
                {previewDiagnostics.queuedSegments} queued / {previewDiagnostics.pendingSamples} pending
              </strong>
              <span>
                init {previewDiagnostics.initSegmentReady ? "ready" : "waiting"} / timescale {previewDiagnostics.trackTimescale}
              </span>
              <span>
                emitted {previewDiagnostics.emittedSegments} / delivered {previewDiagnostics.deliveredSegments}
              </span>
              <span>
                last AU {formatNullableNumber(previewDiagnostics.lastAccessUnitIndex)} @ {formatNullableNumber(previewDiagnostics.lastAccessUnitDuration)} us
              </span>
              <span>
                queued #{formatNullableNumber(previewDiagnostics.lastQueuedSequenceNumber)} [{formatSampleRange(previewDiagnostics.lastQueuedFirstSampleIndex, previewDiagnostics.lastQueuedLastSampleIndex)}]
              </span>
              <span>
                delivered #{formatNullableNumber(previewDiagnostics.lastDeliveredSequenceNumber)} [{formatSampleRange(previewDiagnostics.lastDeliveredFirstSampleIndex, previewDiagnostics.lastDeliveredLastSampleIndex)}]
              </span>
            </div>

            <div className="debug-console-card">
              <span className="diagnostics-label">Append</span>
              <strong>
                {previewClientDiagnostics.mediaAppendCount} media / {previewClientDiagnostics.initAppendCount} init
              </strong>
              <span>
                empty polls {previewClientDiagnostics.emptyPollCount} / errors {previewClientDiagnostics.appendErrorCount}
              </span>
              <span>
                last seq #{formatNullableNumber(previewClientDiagnostics.lastAppendedSequenceNumber)} / bytes {previewClientDiagnostics.lastAppendedBytes}
              </span>
              <span>
                sourceBuffer {previewClientDiagnostics.sourceBufferUpdating ? "updating" : "idle"} / MediaSource {previewClientDiagnostics.mediaSourceReadyState}
              </span>
              <span>
                last append {previewClientDiagnostics.lastAppendAtMs === null ? "-" : `${Math.round(previewClientDiagnostics.lastAppendAtMs)} ms`}
              </span>
            </div>

            <div className="debug-console-card">
              <span className="diagnostics-label">Playback</span>
              <strong>
                t={videoDiagnostics.currentTime.toFixed(2)}s / +{bufferedAhead.toFixed(2)}s
              </strong>
              <span>
                buffer end {videoDiagnostics.bufferedEnd.toFixed(2)}s / readyState {videoDiagnostics.readyState}
              </span>
              <span>paused {videoDiagnostics.paused ? "yes" : "no"}</span>
              <span>
                decoded {videoDiagnostics.totalVideoFrames} / dropped {videoDiagnostics.droppedVideoFrames}
              </span>
            </div>
          </div>
        ) : null}
      </section>

      <footer className="shell-footer">
        <div className="footer-block">
          <strong>Capture</strong>
          <span>{session.captureCount} shots</span>
        </div>
        <div className="footer-block footer-block-scale">
          {scaleSteps.map((step) => (
            <button
              key={step}
              type="button"
              className={step === scale ? "active" : ""}
              onClick={() => setScale(step)}
            >
              {step}%
            </button>
          ))}
        </div>
        <div className="footer-block">
          <strong>State</strong>
          <span>{sessionLabels[sessionState]}</span>
        </div>
      </footer>
    </main>
  );
}

export default App;
