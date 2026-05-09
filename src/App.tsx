import type { CSSProperties } from "react";
import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import "./App.css";

const scaleSteps = [75, 85, 100] as const;
const SESSION_STATUS_EVENT = "session-status";
const PREVIEW_TELEMETRY_EVENT = "preview-telemetry";

type Orientation = "portrait" | "landscape";
type GlyphName = "home" | "camera" | "rotate" | "record" | "scale";
type SessionState = "idle" | "discovering" | "connecting" | "mirroring" | "recording";
type SessionCommand =
  | "get_session_snapshot"
  | "get_preview_telemetry"
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
  connecting: "Negotiating the receiver session and warming the first media pipeline.",
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

function formatCommandError(error: unknown) {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
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
  }
}

function App() {
  const [orientation, setOrientation] = useState<Orientation>("portrait");
  const [scale, setScale] = useState<(typeof scaleSteps)[number]>(100);
  const [session, setSession] = useState<SessionSnapshot>(initialSnapshot);
  const [preview, setPreview] = useState<PreviewTelemetry>(initialPreview);
  const [backdropMode, setBackdropMode] = useState<"clean" | "stage">("clean");
  const [commandPending, setCommandPending] = useState(false);
  const [commandError, setCommandError] = useState<string | null>(null);

  const sessionState = session.status;
  const shellTitle = orientation === "portrait" ? `${session.deviceName} - iOS 17.2` : `${session.deviceName} - Landscape`;
  const deviceMetrics = orientation === "portrait" ? "393 x 852 pt" : "852 x 393 pt";
  const sessionIndex = sessionOrder.indexOf(sessionState);
  const sessionProgress = `${((sessionIndex / (sessionOrder.length - 1)) * 100).toFixed(0)}%`;
  const canCapture = sessionState === "mirroring" || sessionState === "recording";
  const canRecord = sessionState === "mirroring" || sessionState === "recording";
  const previewBars = Array.from({ length: 10 }, (_, index) => {
    const base = ((preview.frameNumber + index * 3) % 7) + 2;
    return Math.max(16, Math.round(base * 8 * (0.45 + preview.activity)));
  });

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

        const [snapshot, previewTelemetry] = await Promise.all([
          invokeSessionCommand("get_session_snapshot") as Promise<SessionSnapshot>,
          invokeSessionCommand("get_preview_telemetry") as Promise<PreviewTelemetry>,
        ]);

        if (isMounted) {
          setSession(snapshot);
          setPreview(previewTelemetry);
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
                <div className="status-bar">
                  <span>7:20</span>
                  <div className="status-icons">
                    <span className="signal-dots" />
                    <span className="wifi-mark" />
                    <span className="battery-mark" />
                  </div>
                </div>

                <div className="wallpaper-glow wallpaper-glow-top" />
                <div className="wallpaper-glow wallpaper-glow-bottom" />

                <div className="session-content">
                  <div className="session-hero">
                    <div className="session-chip">{sessionLabels[sessionState]}</div>
                    <h2>Mirror pipeline</h2>
                    <p>{sessionDescriptions[sessionState]}</p>
                    <div className={`session-bridge-note ${commandError ? "session-bridge-note-error" : ""}`}>
                      {commandError ?? (commandPending ? "Syncing with the Rust session manager..." : "Driven by Tauri commands and backend events.")}
                    </div>
                  </div>

                  <div className="mirror-preview">
                    <div className="preview-overlay" />
                    <div className="preview-frame preview-frame-one" />
                    <div className="preview-frame preview-frame-two" />
                    <div className="preview-hud">
                      <span>{preview.fps} FPS</span>
                      <span>{preview.latencyMs} ms</span>
                      <span>{(preview.bitrateKbps / 1000).toFixed(1)} Mbps</span>
                    </div>
                    <div className="preview-scanlines">
                      {previewBars.map((height, index) => (
                        <span
                          key={`${preview.frameNumber}-${index}`}
                          className="preview-bar"
                          style={{ height: `${height}px` }}
                        />
                      ))}
                    </div>
                    <div className="preview-copy">
                      <strong>{sessionState === "idle" ? "No active stream" : sessionState === "recording" ? "Recording active" : "Live device surface"}</strong>
                      <span>{sessionState === "idle" ? "Start discovery to stage a session." : `Frame ${preview.frameNumber} is arriving over the mock transport boundary.`}</span>
                    </div>
                  </div>

                  <div className="session-stats">
                    <div className="session-stat">
                      <span>Session</span>
                      <strong>{sessionProgress}</strong>
                    </div>
                    <div className="session-stat">
                      <span>Shots</span>
                      <strong>{session.captureCount}</strong>
                    </div>
                    <div className="session-stat">
                      <span>Mode</span>
                      <strong>{sessionState === "recording" ? "REC" : orientation === "portrait" ? "P" : "L"}</strong>
                    </div>
                    <div className="session-stat">
                      <span>Frames</span>
                      <strong>{preview.frameNumber}</strong>
                    </div>
                  </div>

                  <div className="session-actions">
                    <button
                      type="button"
                      className="session-primary-action"
                      onClick={handlePrimaryAction}
                      disabled={commandPending}
                    >
                      {commandPending ? "Working..." : sessionActions[sessionState]}
                    </button>
                    <button
                      type="button"
                      className="session-secondary-action"
                      onClick={() => void runSessionCommand("stop_session")}
                      disabled={sessionState === "idle" || commandPending}
                    >
                      Reset shell
                    </button>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
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
