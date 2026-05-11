import type { MouseEvent, ReactNode } from "react";

import { cn } from "@/lib/utils";
import type { ZoomLevel } from "@/features/mirrorsim/constants";
import { fmtDuration } from "@/features/mirrorsim/helpers";
import type { Capture, Orientation } from "@/features/mirrorsim/types";
import type { BonjourStatusSnapshot } from "@/receiverContract";

import { Icon } from "./Icon";
import { WindowControls } from "./WindowControls";

type ConsoleViewProps = {
  panelSurfaceClass: string;
  controlButtonClass: string;
  sideButtonClass: string;
  bonjourToneClass: string;
  bonjourStatus: BonjourStatusSnapshot;
  bonjourNeedsAttention: boolean;
  captures: Capture[];
  canCapture: boolean;
  canRecord: boolean;
  commandPending: boolean;
  commandError: string | null;
  currentDeviceTrusted: boolean;
  currentDeviceVisible: boolean;
  deviceFrame: ReactNode;
  diagExpanded: boolean;
  diagnosticsItems: Array<[string, string]>;
  idleTelemetryHint: string;
  isConnected: boolean;
  isIdle: boolean;
  isLive: boolean;
  isRec: boolean;
  isTransitioningSession: boolean;
  onAdjustZoom: (delta: 1 | -1) => void;
  onCapture: () => void;
  onGoMinimal: () => void;
  onInstallBonjour: () => void;
  onOpenSettings: () => void;
  onOpenWindowsServices: () => void;
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
  primarySessionActionDisabled: boolean;
  primarySessionActionLabel: string;
  primarySessionActionTitle: string;
  recElapsed: number;
  reconnectBadge: ReactNode;
  sessionHeadline: string;
  sessionSecondaryLabel: string;
  sessionSupportingText: string;
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
  sideButtonClass,
  bonjourToneClass,
  bonjourStatus,
  bonjourNeedsAttention,
  captures,
  canCapture,
  canRecord,
  commandPending,
  currentDeviceTrusted,
  currentDeviceVisible,
  deviceFrame,
  diagExpanded,
  diagnosticsItems,
  idleTelemetryHint,
  isConnected,
  isIdle,
  isLive,
  isRec,
  isTransitioningSession,
  onAdjustZoom,
  onCapture,
  onGoMinimal,
  onInstallBonjour,
  onOpenSettings,
  onOpenWindowsServices,
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
  primarySessionActionDisabled,
  primarySessionActionLabel,
  primarySessionActionTitle,
  recElapsed,
  reconnectBadge,
  sessionHeadline,
  sessionSecondaryLabel,
  sessionSupportingText,
  settingsModal,
  technicalDetails,
  trustedDevicesCount,
  updateBanner,
  zoom,
  zoomIndex,
  zoomMaxIndex,
}: ConsoleViewProps) {
  return (
    <div className="grid h-screen overflow-hidden bg-[#0e0f11] text-white [grid-template-rows:36px_1fr_48px_36px]">
      <div className={cn("grid grid-cols-[auto_1fr_auto] items-center gap-2 border-b px-2.5", panelSurfaceClass)}>
        <WindowControls />
        <div className="flex h-full items-center justify-center" onMouseDown={(event) => void onStartWindowDrag(event)}>
          <div className="flex items-center gap-2">
            <span className="select-none text-[13px] font-semibold tracking-[-0.015em] text-white/90">MirrorSim</span>
            {reconnectBadge}
          </div>
        </div>
        <div className="flex items-center justify-end gap-1.5">
          {isRec && (
            <span className="inline-flex items-center gap-1 whitespace-nowrap rounded-full border border-red-500/25 bg-red-500/15 px-2 py-0.5 text-[11px] font-medium tracking-[-0.01em] text-red-300">
              ● REC {fmtDuration(recElapsed)}
            </span>
          )}
          {isLive && !isRec && (
            <span className="inline-flex items-center gap-1 whitespace-nowrap rounded-full border border-red-500/25 bg-red-500/15 px-2 py-0.5 text-[11px] font-medium tracking-[-0.01em] text-red-300">
              ● Live
            </span>
          )}
          {isLive && (
            <span className="inline-flex items-center rounded-full border border-white/7 bg-[#1a1b1e] px-2 py-0.5 text-[11px] font-medium tracking-[-0.01em] text-white/55">
              {previewPresetLabel} · H.264 · {previewFps > 0 ? `${previewFps} fps` : "—"}
            </span>
          )}
          <button
            type="button"
            className="inline-flex h-7 w-7 items-center justify-center text-cyan-300 transition hover:text-white"
            onClick={onGoMinimal}
            title="Switch to phone view (Ctrl+M)"
          >
            <Icon name="phone" size={14} />
          </button>
        </div>
      </div>

      <div className="grid min-h-0 grid-cols-[52px_1fr_252px] overflow-hidden">
        <aside className={cn("flex flex-col items-center border-r py-2.5", panelSurfaceClass)}>
          <div className="flex flex-1 flex-col items-center gap-0.5">
            <button
              type="button"
              className={cn(sideButtonClass, isConnected && "bg-emerald-500/10 text-emerald-400")}
              onClick={onPrimary}
              disabled={primarySessionActionDisabled}
              title={primarySessionActionTitle}
            >
              <Icon name="phone" />
            </button>
            <button
              type="button"
              className={sideButtonClass}
              onClick={onCapture}
              disabled={!canCapture || commandPending}
              title="Screenshot (Ctrl+S)"
            >
              <Icon name="camera" />
            </button>
            <button
              type="button"
              className={cn(sideButtonClass, isRec && "bg-red-500/15 text-red-300")}
              onClick={onRecordToggle}
              disabled={!canRecord || commandPending}
              title="Record (Ctrl+R)"
            >
              <Icon name="record" />
            </button>
          </div>
          <div className="flex flex-col items-center gap-0.5">
            <button type="button" className={sideButtonClass} onClick={onRotate} title="Rotate device">
              <Icon name="rotate" />
            </button>
          </div>
        </aside>

        <div
          className="relative flex items-center justify-center overflow-hidden bg-[#0e0f11]"
          onWheel={(event) => {
            event.preventDefault();
            onAdjustZoom(event.deltaY < 0 ? 1 : -1);
          }}
        >
          <div className="origin-center transition-transform duration-200" style={{ transform: `scale(${zoom})` }}>
            {deviceFrame}
          </div>
        </div>

        <aside className={cn("flex min-h-0 flex-col overflow-hidden border-l", panelSurfaceClass)}>
          <div className="flex flex-col gap-2 border-b border-white/7 p-3.5">
            <div className="text-[10px] font-semibold uppercase tracking-[0.08em] text-white/25">Session</div>
            {bonjourNeedsAttention && (
              <div className={cn("rounded-[8px] border p-2.5", bonjourToneClass)}>
                <div className="text-[11px] font-medium">
                  {bonjourStatus.status === "missing" ? "Bonjour is not installed" : "Bonjour service isn't running"}
                </div>
                <p className="mt-1 text-[11px] leading-4 text-inherit/80">{bonjourStatus.detail}</p>
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {bonjourStatus.status === "missing" ? (
                    <button
                      type="button"
                      className="inline-flex items-center rounded-[5px] border border-white/10 bg-black/20 px-2.5 py-1 text-[11px] font-medium text-inherit transition hover:border-white/20"
                      onClick={onInstallBonjour}
                    >
                      Install Bonjour
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="inline-flex items-center rounded-[5px] border border-white/10 bg-black/20 px-2.5 py-1 text-[11px] font-medium text-inherit transition hover:border-white/20"
                      onClick={onOpenWindowsServices}
                    >
                      Open Services
                    </button>
                  )}
                  <button
                    type="button"
                    className="inline-flex items-center rounded-[5px] border border-white/10 bg-black/20 px-2.5 py-1 text-[11px] font-medium text-inherit transition hover:border-white/20"
                    onClick={onRefreshBonjourStatus}
                  >
                    Recheck
                  </button>
                </div>
              </div>
            )}
            {updateBanner}
            <div className="flex items-start gap-2.5">
              <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-xl border border-white/8 bg-[#1a1b1e] text-white/55">
                <Icon name="phone" size={14} />
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <div className="truncate text-[15px] font-semibold tracking-[-0.025em] text-white/90">{sessionHeadline}</div>
                  <div className={cn("h-1.5 w-1.5 shrink-0 rounded-full", isLive ? "bg-emerald-400" : isTransitioningSession ? "bg-amber-300" : "bg-white/18")} />
                </div>
                <div className="mt-1 text-[11px] text-white/35">{sessionSecondaryLabel}</div>
                <p className="mt-2 text-[11px] leading-5 text-white/45">{sessionSupportingText}</p>
              </div>
            </div>
            <div className="mt-3 flex flex-wrap gap-2">
              <button
                type="button"
                className="inline-flex items-center rounded-xl border border-white/8 bg-white/5 px-3 py-1.5 text-[11px] font-medium text-white/75 transition hover:border-white/14 hover:bg-white/10 hover:text-white disabled:cursor-default disabled:opacity-40"
                onClick={onPrimary}
                disabled={primarySessionActionDisabled}
              >
                {primarySessionActionLabel}
              </button>
              {!isIdle && !isRec && (
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
                  className="inline-flex items-center rounded-xl border border-white/7 bg-[#1a1b1e] px-3 py-1.5 text-[11px] font-medium text-white/55 transition hover:border-white/12 hover:text-white"
                  onClick={onOpenSettings}
                >
                  {trustedDevicesCount > 0 ? `Trusted Devices (${trustedDevicesCount})` : "Trusted Devices"}
                </button>
              )}
            </div>
            {currentDeviceVisible && (
              <div className="mt-2 text-[11px] text-white/38">
                {currentDeviceTrusted
                  ? "This connected iPhone is trusted on this PC."
                  : "Trust this iPhone to keep a remembered relationship on this PC."}
              </div>
            )}
            {technicalDetails}
          </div>

          <div className="flex min-h-0 flex-1 flex-col gap-2 border-b border-white/7 p-3.5">
            <div className="text-[10px] font-semibold uppercase tracking-[0.08em] text-white/25">Captures</div>
            <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
              {captures.length === 0 ? (
                <div className="py-1 text-[11px] text-white/25">No captures yet</div>
              ) : (
                [...captures].reverse().map((capture) => (
                  <div key={capture.id} className="flex items-center gap-2 border-b border-white/7 py-2 last:border-b-0">
                    <div
                      className={cn(
                        "flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded text-[11px]",
                        capture.type === "screenshot"
                          ? "bg-emerald-500/12 text-emerald-400"
                          : "bg-red-500/14 text-red-300",
                      )}
                    >
                      <Icon name={capture.type === "screenshot" ? "camera" : "record"} size={11} />
                    </div>
                    <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                      <span className="truncate text-[11px] text-white/90">{capture.name}</span>
                      {capture.duration !== undefined && (
                        <span className="text-[10px] text-white/25">{fmtDuration(capture.duration)}</span>
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

          <div className="mt-auto">
            <button
              type="button"
              className="flex w-full items-center gap-1.5 px-3.5 py-2.5 text-left text-[11px] font-medium text-white/25 transition hover:text-white/55"
              onClick={onToggleDiagnostics}
            >
              <Icon name={diagExpanded ? "chevron-down" : "chevron-right"} size={13} />
              Diagnostics
            </button>
            {diagExpanded && (
              <div className="flex max-h-[220px] flex-col gap-1.5 overflow-y-auto px-3.5 pb-3">
                {diagnosticsItems.map(([label, value]) => (
                  <div key={label} className="flex items-center justify-between gap-3 text-[11px]">
                    <span className="text-white/25">{label}</span>
                    <strong className="max-w-[60%] truncate text-right font-medium text-white/90">{value}</strong>
                  </div>
                ))}
              </div>
            )}
          </div>
        </aside>
      </div>

      <div className={cn("flex items-center justify-between gap-1 border-y px-3", panelSurfaceClass)}>
        <div className="flex items-center gap-px">
          <button
            type="button"
            className={cn(controlButtonClass, isRec && "bg-red-500/15 text-red-300")}
            onClick={onRecordToggle}
            disabled={!canRecord || commandPending}
            title="Toggle recording (⌘R)"
          >
            <Icon name="record" size={15} />
          </button>
          <button
            type="button"
            className={controlButtonClass}
            onClick={onCapture}
            disabled={!canCapture || commandPending}
            title="Screenshot (⌘S)"
          >
            <Icon name="camera" size={15} />
          </button>
          <div className="mx-1.5 h-4 w-px bg-white/7" />
          <button type="button" className={controlButtonClass} onClick={onToggleFullscreen} title="Fullscreen (Ctrl+F)">
            <Icon name="fullscreen" size={15} />
          </button>
          <button
            type="button"
            className={controlButtonClass}
            onClick={() => onAdjustZoom(-1)}
            disabled={zoomIndex === 0}
            title="Zoom Out"
          >
            <Icon name="zoom-out" size={15} />
          </button>
          <span className="min-w-[26px] text-center text-[11px] font-semibold tracking-[-0.03em] text-white/55">{zoom}×</span>
          <button
            type="button"
            className={controlButtonClass}
            onClick={() => onAdjustZoom(1)}
            disabled={zoomIndex === zoomMaxIndex}
            title="Zoom In"
          >
            <Icon name="zoom-in" size={15} />
          </button>
          <div className="mx-1.5 h-4 w-px bg-white/7" />
          <button type="button" className={controlButtonClass} onClick={onRotate} title="Rotate device">
            <Icon name="rotate" size={15} />
          </button>
        </div>
        <div className="flex items-center gap-px">
          <button type="button" className={controlButtonClass} title="Settings" onClick={onOpenSettings}>
            <Icon name="settings" size={15} />
          </button>
        </div>
      </div>

      <div className="flex items-center gap-0 bg-[#0e0f11] px-4">
        {isLive ? (
          <>
            <div className="flex items-center gap-2 whitespace-nowrap">
              <span className="text-[11px] tracking-[-0.01em] text-white/25">Latency</span>
              <strong className="min-w-[48px] text-right text-[11px] font-semibold tracking-[-0.02em] tabular-nums text-white/90">{`${previewLatencyMs} ms`}</strong>
            </div>
            <div className="mx-3.5 h-3 w-px bg-white/7" />
            <div className="flex items-center gap-2 whitespace-nowrap">
              <span className="text-[11px] tracking-[-0.01em] text-white/25">Frame rate</span>
              <strong className="min-w-[46px] text-right text-[11px] font-semibold tracking-[-0.02em] tabular-nums text-white/90">{`${previewFps} fps`}</strong>
            </div>
            <div className="mx-3.5 h-3 w-px bg-white/7" />
            <div className="flex items-center gap-2 whitespace-nowrap">
              <span className="text-[11px] tracking-[-0.01em] text-white/25">Bitrate</span>
              <strong className="min-w-[64px] text-right text-[11px] font-semibold tracking-[-0.02em] tabular-nums text-white/90">
                {`${(previewBitrateKbps / 1000).toFixed(1)} Mbps`}
              </strong>
            </div>
            <div className="mx-3.5 h-3 w-px bg-white/7" />
            <div className="flex items-center gap-2 whitespace-nowrap">
              <span className="text-[11px] tracking-[-0.01em] text-white/25">Resolution</span>
              <strong className="min-w-[58px] text-right text-[11px] font-semibold tracking-[-0.02em] tabular-nums text-white/90">
                {orientation === "portrait" ? "393×852" : "852×393"}
              </strong>
            </div>
          </>
        ) : (
          <div className="flex w-full items-center justify-between gap-4 text-[11px] text-white/35">
            <span className="truncate">{idleTelemetryHint}</span>
            <button
              type="button"
              className="shrink-0 rounded-full border border-white/8 bg-white/5 px-2.5 py-1 text-[10px] font-medium text-white/65 transition hover:border-white/14 hover:bg-white/10 hover:text-white"
              onClick={onOpenSettings}
            >
              Preferences
            </button>
          </div>
        )}
      </div>
      {settingsModal}
    </div>
  );
}