import { useLayoutEffect, useRef, useState, type MouseEvent, type ReactNode } from "react";

import { cn } from "@/lib/utils";
import type { ZoomLevel } from "@/features/mirrorsim/constants";
import { fmtDuration } from "@/features/mirrorsim/helpers";
import { formatKeyboardShortcuts, keyboardShortcutsToAria } from "@/features/mirrorsim/keyboardShortcuts";
import type { Capture, KeyboardShortcutMap, Orientation } from "@/features/mirrorsim/types";
import type { BonjourStatusSnapshot } from "@/receiverContract";

import { Icon } from "./Icon";
import { WindowControls } from "./WindowControls";

type ConsoleViewProps = {
  panelSurfaceClass: string;
  controlButtonClass: string;
  bonjourToneClass: string;
  bonjourStatus: BonjourStatusSnapshot;
  bonjourNeedsAttention: boolean;
  captures: Capture[];
  captureNotice: string | null;
  canCapture: boolean;
  canRecord: boolean;
  audioAvailable: boolean;
  audioMuted: boolean;
  keyboardShortcuts: KeyboardShortcutMap;
  commandPending: boolean;
  commandError: string | null;
  currentDeviceTrusted: boolean;
  currentDeviceVisible: boolean;
  deviceFrame: ReactNode;
  diagExpanded: boolean;
  diagnosticsItems: Array<[string, string]>;
  isLive: boolean;
  isRec: boolean;
  phoneSteps: [string, string, string];
  showPhoneSteps: boolean;
  sessionTone: "idle" | "active" | "live" | "warning";
  onAdjustZoom: (delta: 1 | -1) => void;
  onCapture: () => void;
  onToggleAudio: () => void;
  onGoMinimal: () => void;
  onOpenSettings: () => void;
  onOpenDevicesSettings: () => void;
  onPrimary: () => void;
  onRecordToggle: () => void;
  onRefreshBonjourStatus: () => void;
  onRevealCapture: (capture: Capture) => void;
  onRetryConnection: () => void;
  onRotate: () => void;
  onStartWindowDrag: (event: MouseEvent<HTMLElement>) => void | Promise<void>;
  onTrustCurrentDevice: () => void;
  onToggleDiagnostics: () => void;
  onToggleFullscreen: () => void;
  orientation: Orientation;
  previewFps: number;
  previewLatencyMs: number;
  previewBitrateKbps: number;
  previewPresetLabel: string;
  previewResolutionLabel: string;
  primarySessionActionDisabled: boolean;
  primarySessionActionLabel: string;
  recElapsed: number;
  reconnectBadge: ReactNode;
  sessionHeadline: string;
  sessionSecondaryLabel: string;
  sessionSupportingText: string;
  showRetryConnection: boolean;
  settingsOpen: boolean;
  settingsModal: ReactNode;
  technicalDetails: ReactNode;
  trustedDevicesCount: number;
  updateBanner: ReactNode;
  zoom: ZoomLevel;
  zoomIndex: number;
  zoomMaxIndex: number;
};

export function ConsoleView({
  panelSurfaceClass,
  controlButtonClass,
  bonjourToneClass,
  bonjourStatus,
  bonjourNeedsAttention,
  captures,
  captureNotice,
  canCapture,
  canRecord,
  audioAvailable,
  audioMuted,
  keyboardShortcuts,
  commandPending,
  commandError,
  currentDeviceTrusted,
  currentDeviceVisible,
  deviceFrame,
  diagExpanded,
  diagnosticsItems,
  isLive,
  isRec,
  phoneSteps,
  showPhoneSteps,
  sessionTone,
  onAdjustZoom,
  onCapture,
  onToggleAudio,
  onGoMinimal,
  onOpenSettings,
  onOpenDevicesSettings,
  onPrimary,
  onRecordToggle,
  onRefreshBonjourStatus,
  onRevealCapture,
  onRetryConnection,
  onRotate,
  onStartWindowDrag,
  onTrustCurrentDevice,
  onToggleDiagnostics,
  onToggleFullscreen,
  orientation,
  previewFps,
  previewLatencyMs,
  previewBitrateKbps,
  previewPresetLabel,
  previewResolutionLabel,
  primarySessionActionDisabled,
  primarySessionActionLabel,
  recElapsed,
  reconnectBadge,
  sessionHeadline,
  sessionSecondaryLabel,
  sessionSupportingText,
  showRetryConnection,
  settingsOpen,
  settingsModal,
  technicalDetails,
  trustedDevicesCount,
  updateBanner,
  zoom,
  zoomIndex,
  zoomMaxIndex,
}: ConsoleViewProps) {
  const shortcutLabel = (action: keyof KeyboardShortcutMap) => formatKeyboardShortcuts(keyboardShortcuts[action]);
  const shortcutAria = (action: keyof KeyboardShortcutMap) => keyboardShortcutsToAria(keyboardShortcuts[action]);
  const previewStageRef = useRef<HTMLDivElement | null>(null);
  const previewFrameRef = useRef<HTMLDivElement | null>(null);
  const [fitScale, setFitScale] = useState(1);
  const sessionDotClass = sessionTone === "live"
    ? "bg-emerald-400"
    : sessionTone === "warning"
      ? "bg-red-400"
      : sessionTone === "active"
        ? "bg-cyan-300"
        : "bg-white/35";
  const screenshotTooltip = canCapture
    ? `Screenshot (${shortcutLabel("takeScreenshot")})`
    : "Screenshot available when iPhone video is ready";
  const recordingTooltip = isRec
    ? `Stop recording (${shortcutLabel("toggleRecording")})`
    : canRecord
      ? `Start recording (${shortcutLabel("toggleRecording")})`
      : "Recording available when iPhone video is ready";

  useLayoutEffect(() => {
    const stage = previewStageRef.current;
    const frame = previewFrameRef.current;
    if (!stage || !frame) return;

    const updateFit = () => {
      const width = frame.offsetWidth;
      const height = frame.offsetHeight;
      if (width === 0 || height === 0) return;
      setFitScale(Math.min(1, Math.max(0.1, (stage.clientWidth - 24) / width, 0.1), Math.max(0.1, (stage.clientHeight - 24) / height, 0.1)));
    };

    const observer = new ResizeObserver(updateFit);
    observer.observe(stage);
    observer.observe(frame);
    updateFit();
    return () => observer.disconnect();
  }, [orientation]);

  return (
    <div
      className={cn(
        "grid h-screen overflow-hidden bg-[#0e0f11] text-white",
        isLive ? "grid-rows-[36px_1fr_48px_36px]" : "grid-rows-[36px_1fr_48px]",
      )}
    >
      <div
        className={cn("relative z-50 grid cursor-grab grid-cols-[1fr_auto_1fr] items-center gap-2 overflow-visible border-b px-2.5 active:cursor-grabbing", panelSurfaceClass)}
        onMouseDown={(event) => void onStartWindowDrag(event)}
      >
        <div className="justify-self-start">
          <WindowControls />
        </div>
        <div
          className="flex h-full items-center justify-center"
          onMouseDown={(event) => {
            if ((event.target as HTMLElement).closest("button")) event.stopPropagation();
          }}
        >
          <div className="flex items-center gap-2">
            <span className="select-none text-[13px] font-semibold tracking-[-0.015em] text-white/90">MirrorSim</span>
            {reconnectBadge}
          </div>
        </div>
        <div className="flex items-center justify-end">
          <div className="flex cursor-default items-center gap-1.5" onMouseDown={(event) => event.stopPropagation()}>
          {isRec && (
            <span className="inline-flex items-center gap-1 whitespace-nowrap rounded-full border border-red-500/25 bg-red-500/15 px-2 py-0.5 text-[11px] font-medium tracking-[-0.01em] text-red-300">
              ● REC {fmtDuration(recElapsed)}
            </span>
          )}
          {isLive && !isRec && (
            <span className="inline-flex items-center gap-1 whitespace-nowrap rounded-full border border-emerald-400/20 bg-emerald-500/10 px-2 py-0.5 text-[11px] font-medium tracking-[-0.01em] text-emerald-300">
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" aria-hidden="true" /> Mirroring
            </span>
          )}
          {isLive && (
            <span className="inline-flex items-center rounded-full border border-white/7 bg-[#1a1b1e] px-2 py-0.5 text-[11px] font-medium tracking-[-0.01em] text-white/55">
              {previewPresetLabel} · H.264 · {previewFps > 0 ? `${previewFps} fps` : "—"}
            </span>
          )}
          <button
            type="button"
            className="inline-flex h-7 w-7 items-center justify-center text-white/55 transition hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-cyan-300/65"
            onClick={onGoMinimal}
            data-tooltip={`Switch to phone view (${shortcutLabel("toggleView")})`}
            data-tooltip-align="end"
            aria-label="Switch to phone view"
            aria-keyshortcuts={shortcutAria("toggleView")}
          >
            <Icon name="phone" size={14} />
          </button>
          </div>
        </div>
      </div>

      <div className="grid min-h-0 grid-cols-[minmax(0,1fr)_252px] overflow-hidden">
        <div
          ref={previewStageRef}
          className="relative flex items-center justify-center overflow-hidden bg-[#0e0f11]"
          onWheel={(event) => {
            event.preventDefault();
            onAdjustZoom(event.deltaY < 0 ? 1 : -1);
          }}
        >
          <div
            ref={previewFrameRef}
            className="origin-center transition-transform duration-200"
            style={{ transform: `scale(${zoom * fitScale})` }}
          >
            {deviceFrame}
          </div>
        </div>

        <aside className={cn("min-h-0 overflow-y-auto border-l", panelSurfaceClass)}>
          <div className="flex flex-col gap-2 border-b border-white/7 p-3.5">
            <div className="text-[10px] font-semibold uppercase tracking-[0.08em] text-white/45">Session</div>
            {bonjourNeedsAttention && (
              <div className={cn("rounded-lg border p-2.5", bonjourToneClass)}>
                <div className="text-[11px] font-medium">
                  AirPlay discovery needs attention
                </div>
                <p className="mt-1 text-[11px] leading-4 text-inherit/80">{bonjourStatus.detail}</p>
                <div className="mt-2 flex flex-wrap gap-1.5">
                  <button
                    type="button"
                    className="inline-flex items-center rounded-[5px] border border-white/10 bg-black/20 px-2.5 py-1 text-[11px] font-medium text-inherit transition hover:border-white/20"
                    onClick={onRefreshBonjourStatus}
                  >
                    Retry discovery
                  </button>
                </div>
              </div>
            )}
            {updateBanner}
            {commandError && (
              <div
                role="alert"
                aria-live="assertive"
                className="rounded-lg border border-red-400/20 bg-red-500/10 p-2.5 text-[11px] leading-4 text-red-100"
              >
                <div className="font-medium">Action failed</div>
                <div className="mt-1 break-all opacity-80">{commandError}</div>
              </div>
            )}
            <div className="flex items-start gap-2.5">
              <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-xl border border-white/8 bg-[#1a1b1e] text-white/55">
                <Icon name="phone" size={14} />
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <div className="truncate text-[15px] font-semibold tracking-tight text-white/90" title={sessionHeadline}>{sessionHeadline}</div>
                  <div className={cn("h-1.5 w-1.5 shrink-0 rounded-full", sessionDotClass)} />
                </div>
                <div className="mt-1 text-[11px] text-white/55">{sessionSecondaryLabel}</div>
                <p className="mt-2 text-[11px] leading-5 text-white/58">{sessionSupportingText}</p>
              </div>
            </div>
            {showPhoneSteps && (
              <div className="mt-1 rounded-xl border border-white/8 bg-black/12 px-3 py-2.5">
                <div className="text-[9px] font-semibold uppercase tracking-[0.1em] text-white/45">On your iPhone</div>
                <ol className="mt-1.5 divide-y divide-white/7">
                  {phoneSteps.map((step, index) => (
                    <li key={step} className="flex min-h-8 items-center gap-2.5 py-1.5">
                      <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full border border-cyan-200/15 bg-cyan-300/[0.065] text-[9px] font-semibold tabular-nums text-cyan-100/75">
                        {index + 1}
                      </span>
                      <span className="text-[11px] font-medium text-white/72">{step}</span>
                    </li>
                  ))}
                </ol>
              </div>
            )}
            <div className="mt-3 flex flex-wrap gap-2">
              <button
                type="button"
                className="inline-flex items-center rounded-xl border border-white/8 bg-white/5 px-3 py-1.5 text-[11px] font-medium text-white/75 transition hover:border-white/14 hover:bg-white/10 hover:text-white disabled:cursor-default disabled:opacity-40"
                onClick={onPrimary}
                disabled={primarySessionActionDisabled}
              >
                {primarySessionActionLabel}
              </button>
              {showRetryConnection && !isRec && (
                <button
                  type="button"
                  className="inline-flex items-center gap-1.5 rounded-xl border border-white/7 bg-[#1a1b1e] px-3 py-1.5 text-[11px] font-medium text-white/55 transition hover:border-white/12 hover:text-white disabled:cursor-default disabled:opacity-40"
                  onClick={onRetryConnection}
                  disabled={commandPending}
                >
                  <Icon name="reconnect" size={12} />
                  Try again
                </button>
              )}
              {currentDeviceVisible && !currentDeviceTrusted && (
                <button
                  type="button"
                  className="inline-flex items-center rounded-xl border border-emerald-400/20 bg-emerald-500/10 px-3 py-1.5 text-[11px] font-medium text-emerald-200 transition hover:bg-emerald-500/15 disabled:cursor-default disabled:opacity-40"
                  onClick={onTrustCurrentDevice}
                  disabled={commandPending}
                >
                  Remember This iPhone
                </button>
              )}
              {(currentDeviceVisible || trustedDevicesCount > 0) && (
                <button
                  type="button"
                  className={cn(
                    "inline-flex items-center rounded-xl border border-white/7 bg-[#1a1b1e] px-3 py-1.5 text-[11px] font-medium text-white/55 transition hover:border-white/12 hover:text-white",
                    settingsOpen && "border-cyan-300/20 bg-cyan-400/10 text-cyan-200",
                  )}
                  onClick={onOpenDevicesSettings}
                  aria-haspopup="dialog"
                  aria-expanded={settingsOpen}
                >
                  {trustedDevicesCount > 0 ? `Trusted Devices (${trustedDevicesCount})` : "Trusted Devices"}
                </button>
              )}
            </div>
            {currentDeviceVisible && (
              <div className="mt-2 text-[11px] text-white/50">
                {currentDeviceTrusted
                  ? "This connected iPhone is trusted on this PC."
                  : "Trust this iPhone to keep a remembered relationship on this PC."}
              </div>
            )}
            {technicalDetails}
          </div>

          <div className="flex flex-col gap-2 border-b border-white/7 p-3.5">
            <div className="text-[10px] font-semibold uppercase tracking-[0.08em] text-white/45">Captures</div>
            {captureNotice && (
              <div
                role="status"
                aria-live="polite"
                className="rounded-lg border border-emerald-300/20 bg-emerald-500/10 p-2.5 text-[11px] leading-4 text-emerald-100"
              >
                <div className="font-medium">Capture status</div>
                <div className="mt-1 break-all opacity-80">{captureNotice}</div>
              </div>
            )}
            <div className="flex flex-col">
              {captures.length === 0 ? (
                <div className="flex items-start gap-2 py-1 text-[11px] leading-4 text-white/48">
                  <Icon name="camera" size={13} />
                  <span>Screenshots and recordings from this session will appear here.</span>
                </div>
              ) : (
                [...captures].reverse().map((capture) => (
                  <div key={capture.id} className="flex items-center gap-2 border-b border-white/7 py-2 last:border-b-0">
                    <div
                      className={cn(
                        "flex h-5.5 w-5.5 shrink-0 items-center justify-center rounded text-[11px]",
                        capture.type === "screenshot"
                          ? "bg-emerald-500/12 text-emerald-400"
                          : "bg-red-500/14 text-red-300",
                      )}
                    >
                      <Icon name={capture.type === "screenshot" ? "camera" : "record"} size={11} />
                    </div>
                    <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                      <span className="truncate text-[11px] text-white/90" title={capture.name}>{capture.name}</span>
                      {capture.duration !== undefined && (
                        <span className="text-[10px] text-white/45">{fmtDuration(capture.duration)}</span>
                      )}
                    </div>
                    {capture.filePath && (
                      <button
                        type="button"
                        className="inline-flex items-center rounded-[5px] border border-white/7 bg-[#1a1b1e] px-2 py-1 text-[10px] font-medium text-white/55 transition hover:border-white/12 hover:text-white"
                        onClick={() => onRevealCapture(capture)}
                      >
                        Reveal
                      </button>
                    )}
                  </div>
                ))
              )}
            </div>
          </div>

          <div>
            <button
              type="button"
              className="flex w-full items-center gap-1.5 px-3.5 py-2.5 text-left text-[11px] font-medium text-white/48 transition hover:text-white/75"
              onClick={onToggleDiagnostics}
              aria-expanded={diagExpanded}
              aria-keyshortcuts={shortcutAria("toggleDiagnostics")}
              data-tooltip={`Toggle diagnostics (${shortcutLabel("toggleDiagnostics")})`}
            >
              <Icon name={diagExpanded ? "chevron-down" : "chevron-right"} size={13} />
              Diagnostics
            </button>
            {diagExpanded && (
              <div className="flex max-h-55 flex-col gap-1.5 overflow-y-auto px-3.5 pb-3">
                {diagnosticsItems.map(([label, value]) => (
                  <div key={label} className="flex items-center justify-between gap-3 text-[11px]">
                    <span className="text-white/48">{label}</span>
                    <strong className="max-w-[60%] truncate text-right font-medium text-white/90" title={value}>{value}</strong>
                  </div>
                ))}
              </div>
            )}
          </div>
        </aside>
      </div>

      <div className={cn("relative z-50 flex items-center justify-between gap-1 overflow-visible border-y px-3", panelSurfaceClass)}>
        <div className="flex items-center gap-px">
          <button
            type="button"
            className={cn(controlButtonClass, isRec && "bg-red-500/15 text-red-300")}
            onClick={onRecordToggle}
            disabled={!canRecord || commandPending}
            data-tooltip={recordingTooltip}
            data-tooltip-side="top"
            aria-label={isRec ? "Stop recording" : "Start recording"}
            aria-keyshortcuts={shortcutAria("toggleRecording")}
          >
            <Icon name="record" size={15} />
          </button>
          <button
            type="button"
            className={controlButtonClass}
            onClick={onCapture}
            disabled={!canCapture || commandPending}
            data-tooltip={screenshotTooltip}
            data-tooltip-side="top"
            aria-label="Take screenshot"
            aria-keyshortcuts={shortcutAria("takeScreenshot")}
          >
            <Icon name="camera" size={15} />
          </button>
          <button
            type="button"
            className={controlButtonClass}
            onClick={onToggleAudio}
            disabled={!audioAvailable}
            data-tooltip={!audioAvailable ? "Audio unavailable" : audioMuted ? `Unmute iPhone audio (${shortcutLabel("toggleAudio")})` : `Mute iPhone audio (${shortcutLabel("toggleAudio")})`}
            data-tooltip-side="top"
            aria-label={!audioAvailable ? "iPhone audio unavailable" : "Mute iPhone audio"}
            aria-keyshortcuts={shortcutAria("toggleAudio")}
            aria-pressed={audioMuted}
          >
            <Icon name={audioMuted ? "volume-off" : "volume"} size={15} />
          </button>
          <div className="mx-1.5 h-4 w-px bg-white/7" />
          <button type="button" className={controlButtonClass} onClick={onToggleFullscreen} data-tooltip={`Fullscreen (${shortcutLabel("toggleFullscreen")})`} data-tooltip-side="top" aria-label="Toggle fullscreen" aria-keyshortcuts={shortcutAria("toggleFullscreen")}>
            <Icon name="fullscreen" size={15} />
          </button>
          <button
            type="button"
            className={controlButtonClass}
            onClick={() => onAdjustZoom(-1)}
            disabled={zoomIndex === 0}
            data-tooltip="Zoom out"
            data-tooltip-side="top"
            aria-label="Zoom out"
          >
            <Icon name="zoom-out" size={15} />
          </button>
          <span className="min-w-6.5 text-center text-[11px] font-semibold tracking-[-0.03em] text-white/55">{zoom}×</span>
          <button
            type="button"
            className={controlButtonClass}
            onClick={() => onAdjustZoom(1)}
            disabled={zoomIndex === zoomMaxIndex}
            data-tooltip="Zoom in"
            data-tooltip-side="top"
            aria-label="Zoom in"
          >
            <Icon name="zoom-in" size={15} />
          </button>
          <div className="mx-1.5 h-4 w-px bg-white/7" />
          <button type="button" className={controlButtonClass} onClick={onRotate} data-tooltip="Rotate device" data-tooltip-side="top" aria-label="Rotate device">
            <Icon name="rotate" size={15} />
          </button>
        </div>
        <div className="flex items-center gap-px">
          <button
            type="button"
            className={cn(controlButtonClass, settingsOpen && "bg-cyan-400/12 text-cyan-200 hover:bg-cyan-400/18 hover:text-cyan-100")}
            data-tooltip={settingsOpen ? "Close Preferences" : "Open Preferences"}
            data-tooltip-side="top"
            data-tooltip-align="end"
            onClick={onOpenSettings}
            aria-label={settingsOpen ? "Close Preferences" : "Open Preferences"}
            aria-haspopup="dialog"
            aria-expanded={settingsOpen}
          >
            <Icon name="settings" size={15} />
          </button>
        </div>
      </div>

      {isLive && (
        <div className="flex items-center gap-0 bg-[#0e0f11] px-4">
            <div className="flex items-center gap-2 whitespace-nowrap">
              <span className="text-[11px] tracking-[-0.01em] text-white/48">Latency</span>
              <strong className="min-w-12 text-right text-[11px] font-semibold tracking-[-0.02em] tabular-nums text-white/90">{`${previewLatencyMs} ms`}</strong>
            </div>
            <div className="mx-3.5 h-3 w-px bg-white/7" />
            <div className="flex items-center gap-2 whitespace-nowrap">
              <span className="text-[11px] tracking-[-0.01em] text-white/48">Frame rate</span>
              <strong className="min-w-11.5 text-right text-[11px] font-semibold tracking-[-0.02em] tabular-nums text-white/90">{`${previewFps} fps`}</strong>
            </div>
            <div className="mx-3.5 h-3 w-px bg-white/7" />
            <div className="flex items-center gap-2 whitespace-nowrap">
              <span className="text-[11px] tracking-[-0.01em] text-white/48">Bitrate</span>
              <strong className="min-w-16 text-right text-[11px] font-semibold tracking-[-0.02em] tabular-nums text-white/90">
                {`${(previewBitrateKbps / 1000).toFixed(1)} Mbps`}
              </strong>
            </div>
            <div className="mx-3.5 h-3 w-px bg-white/7" />
            <div className="flex items-center gap-2 whitespace-nowrap">
              <span className="text-[11px] tracking-[-0.01em] text-white/48">Source</span>
              <strong className="min-w-14.5 text-right text-[11px] font-semibold tracking-[-0.02em] tabular-nums text-white/90">
                {previewResolutionLabel}
              </strong>
            </div>
        </div>
      )}
      {settingsModal}
    </div>
  );
}
