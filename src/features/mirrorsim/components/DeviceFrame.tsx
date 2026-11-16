import type { CSSProperties, MouseEventHandler, ReactNode, WheelEventHandler } from "react";

import { cn } from "@/lib/utils";
import { fmtBytes, fmtDuration } from "@/features/mirrorsim/helpers";
import type { AppMode, Orientation, RecordingControls, SessionState } from "@/features/mirrorsim/types";
import type { MockPreviewStreamStatus } from "@/mockPreviewStream";
import type { VideoAvailabilityNotice } from "@/features/mirrorsim/protectedVideo";

import { Icon } from "./Icon";

type DeviceFrameProps = {
  appMode: AppMode;
  deviceFrameWidth: number;
  deviceWidthClass: string;
  orientation: Orientation;
  screenFrameClass: string;
  screenshotFlashActive: boolean;
  sessionState: SessionState;
  isLive: boolean;
  isIdle: boolean;
  isRec: boolean;
  recElapsed: number;
  recording: RecordingControls;
  bonjourNeedsAttention: boolean;
  sessionHeadline: string;
  sessionSupportingText: string;
  compactIdlePresentation?: boolean;
  showPhoneSteps: boolean;
  phoneSteps: [string, string, string];
  /** Short availability label shown while listening, e.g. "Available as MirrorSim". */
  statusLabel?: string;
  primarySessionActionLabel: string;
  primarySessionActionDisabled: boolean;
  onPrimary: () => void;
  previewStatus: MockPreviewStreamStatus;
  previewError: string | null;
  onRetryPreview: () => void;
  videoAvailabilityNotice: VideoAvailabilityNotice;
  onDismissProtectedVideoNotice: () => void;
  previewDimClass: string;
  previewVideoStyle: CSSProperties;
  tone: "inactive" | "live" | "warning";
  overlay?: ReactNode;
  onContextMenu?: MouseEventHandler<HTMLDivElement>;
  onDoubleClick?: MouseEventHandler<HTMLDivElement>;
  onWheel?: WheelEventHandler<HTMLDivElement>;
  setVideoHost: (element: HTMLDivElement | null) => void;
};

export function DeviceFrame({
  appMode,
  deviceFrameWidth,
  deviceWidthClass,
  orientation,
  screenFrameClass,
  screenshotFlashActive,
  sessionState,
  isLive,
  isIdle,
  isRec,
  recElapsed,
  recording,
  bonjourNeedsAttention,
  sessionHeadline,
  sessionSupportingText,
  compactIdlePresentation = false,
  showPhoneSteps,
  phoneSteps,
  statusLabel,
  primarySessionActionLabel,
  primarySessionActionDisabled,
  onPrimary,
  previewStatus,
  previewError,
  onRetryPreview,
  videoAvailabilityNotice,
  onDismissProtectedVideoNotice,
  previewDimClass,
  previewVideoStyle,
  tone,
  overlay,
  onContextMenu,
  onDoubleClick,
  onWheel,
  setVideoHost,
}: DeviceFrameProps) {
  const portrait = orientation === "portrait";
  const listening = sessionState === "discovering" || sessionState === "connecting";
  // The idle call to action gets the prominent button; stop/cancel actions stay quiet.
  const primaryIsStart = isIdle && !bonjourNeedsAttention;

  return (
    <div
      className={cn(
        "relative isolate overflow-hidden border border-white/8 bg-[linear-gradient(180deg,#24262b_0%,#111214_16%,#0a0b0d_100%)] p-[1.5px]",
        appMode === "minimal"
          ? "shadow-[0_18px_36px_rgba(0,0,0,0.28),0_0_0_1px_rgba(255,255,255,0.06)]"
          : "shadow-[0_0_0_1px_rgba(255,255,255,0.08),0_34px_80px_rgba(0,0,0,0.76)]",
        deviceWidthClass,
      )}
      style={{ width: deviceFrameWidth }}
      onContextMenu={onContextMenu}
      onDoubleClick={onDoubleClick}
      onWheel={onWheel}
    >
      <div className="pointer-events-none absolute inset-x-[10%] top-px h-5 rounded-full bg-white/7 blur-xl" />
      <div className="pointer-events-none absolute inset-y-[16%] left-0.5 w-px bg-white/7" />
      <div className="pointer-events-none absolute inset-y-[20%] right-0.5 w-px bg-black/35" />
      <div
        className={cn(
          "relative bg-[linear-gradient(180deg,#0f1013_0%,#080909_22%,#060607_100%)] p-1.25 transition-transform duration-150",
          screenshotFlashActive && "scale-[0.992]",
          orientation === "portrait" ? "rounded-[49px]" : "rounded-[36px]",
        )}
      >
        <div className="pointer-events-none absolute inset-x-3 top-2 h-10 rounded-full bg-white/2.5 blur-2xl" />
        <div className="pointer-events-none absolute inset-x-3 bottom-2 h-10 rounded-full bg-black/18 blur-2xl" />
        <div
          className={cn(
            "pointer-events-none absolute inset-1.25 rounded-[inherit] border border-white/[0.035]",
            orientation === "portrait" ? "rounded-[45px]" : "rounded-[33px]",
          )}
        />
        {/* The sender owns screen cutouts; a synthetic island can cover live content. */}
        <div className={screenFrameClass}>
          <div className="absolute inset-0 rounded-inherit bg-black">
            {!isLive && (
              <div className="absolute inset-0 bg-[radial-gradient(ellipse_70%_40%_at_50%_22%,rgba(57,208,255,0.055),transparent),linear-gradient(180deg,#060709_0%,#08090d_55%,#060708_100%)]" />
            )}
            <div
              ref={setVideoHost}
              className={cn("absolute inset-0 overflow-hidden rounded-inherit transition-opacity", previewDimClass)}
              style={previewVideoStyle}
            />
            {tone !== "live" ? (
              <div
                className={cn(
                  "absolute inset-0",
                  tone === "warning"
                    ? "bg-linear-to-b from-red-950/10 to-red-950/55"
                    : "bg-linear-to-b from-slate-950/10 to-slate-950/50",
                )}
              />
            ) : null}
            <div
              className={cn(
                "pointer-events-none absolute inset-0 bg-white transition-all duration-200",
                screenshotFlashActive ? "opacity-75" : "opacity-0",
              )}
            />
          </div>
          {overlay}
          {isLive && previewStatus !== "ready" && (
            <div className="absolute inset-0 z-20 flex flex-col items-center justify-center bg-black/82 px-8 py-10 text-center">
              <span className="text-white/35" aria-hidden="true">
                <Icon name="phone" size={22} />
              </span>
              <h3 className="mt-4 text-sm font-semibold text-white/88">
                {previewStatus === "loading" ? "Starting iPhone video..." : "Preview interrupted"}
              </h3>
              <p className="mt-2 max-w-60 text-xs leading-5 text-white/55">
                {previewStatus === "loading"
                  ? "The AirPlay connection is active. MirrorSim is waiting for a decodable video frame."
                  : previewError ?? "MirrorSim could not continue decoding the live preview."}
              </p>
              {previewStatus !== "loading" && (
                <button
                  type="button"
                  className="mt-5 rounded-lg border border-white/15 bg-white/8 px-4 py-2 text-xs font-semibold text-white/80 transition hover:bg-white/12 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300/70"
                  onClick={onRetryPreview}
                >
                  Retry preview
                </button>
              )}
            </div>
          )}
          {isLive && previewStatus === "ready" && videoAvailabilityNotice !== null && (
            <div
              className={cn(
                "absolute inset-0 z-20 flex items-center justify-center bg-black/92 px-8 py-8 text-center backdrop-blur-sm",
                orientation === "landscape" && "px-16 py-4",
              )}
              role="status"
              aria-live="polite"
            >
              <div className="flex max-w-sm flex-col items-center">
                <span
                  className={cn(
                    "h-2 w-2 rounded-full",
                    videoAvailabilityNotice === "possible-protected" ? "bg-amber-300/85" : "bg-cyan-300/85",
                  )}
                  aria-hidden="true"
                />
                <p className="mt-4 text-sm font-semibold text-white/92">
                  {videoAvailabilityNotice === "possible-protected"
                    ? "Video picture unavailable"
                    : "Video picture unavailable"}
                </p>
                <p className="mt-2 text-xs leading-5 text-white/58">
                  {videoAvailabilityNotice === "possible-protected"
                    ? "MirrorSim is receiving advancing, nearly black frames with audible audio. Protected playback is one possible cause because iOS can hide the video layer from mirroring."
                    : "The iPhone stopped sending the video picture. Player controls or audio may continue, and MirrorSim will resume automatically when normal picture updates return."}
                </p>
                <button
                  type="button"
                  className="mt-5 rounded-lg border border-white/12 bg-white/7 px-3 py-2 text-xs font-semibold text-white/68 transition hover:bg-white/11 hover:text-white/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-200/60"
                  onClick={onDismissProtectedVideoNotice}
                >
                  Show mirrored screen
                </button>
              </div>
            </div>
          )}
          {recording.countdown !== null && (
            <div
              className="absolute inset-0 z-40 flex flex-col items-center justify-center bg-black/50 text-center backdrop-blur-[2px]"
              aria-live="assertive"
            >
              <span
                key={recording.countdown}
                className={cn(
                  "ms-countdown font-semibold leading-none tracking-[-0.04em] text-white tabular-nums",
                  portrait ? "text-[96px]" : "text-[64px]",
                )}
              >
                {recording.countdown}
              </span>
              <span className={cn("text-[12px] font-medium text-white/70", portrait ? "mt-5" : "mt-3")}>
                Recording starts soon
              </span>
              <span className="mt-1 text-[11px] text-white/40">Press Record or Esc to cancel</span>
            </div>
          )}
          {!isLive && (
            <div
              className={cn(
                "absolute inset-0 z-20 flex flex-col items-center justify-center text-center",
                orientation === "portrait" ? "px-7 py-8" : "px-10 py-4",
              )}
              aria-live="polite"
            >
              {listening && (
                <div
                  aria-hidden="true"
                  className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_50%_36%,rgba(59,130,246,0.09),transparent_50%)]"
                />
              )}
              <div
                className={cn(
                  "relative flex shrink-0 items-center justify-center",
                  portrait ? "mb-6 h-16 w-16" : "mb-3 h-11 w-11",
                )}
              >
                {listening ? (
                  <>
                    {[0, 1, 2].map((ring) => (
                      <span
                        key={ring}
                        aria-hidden="true"
                        className="ms-ripple absolute inset-0 rounded-full border border-blue-400/40"
                        style={{ animationDelay: `${ring * 0.9}s` }}
                      />
                    ))}
                    <span className="relative flex h-full w-full items-center justify-center rounded-full border border-blue-300/30 bg-blue-500/15 text-blue-100 shadow-[0_0_28px_rgba(59,130,246,0.18)]">
                      <Icon name="phone" size={portrait ? 24 : 17} />
                    </span>
                  </>
                ) : (
                  <span className="flex h-full w-full items-center justify-center rounded-full border border-white/10 bg-white/[0.04] text-white/55">
                    <Icon name="phone" size={portrait ? 24 : 17} />
                  </span>
                )}
              </div>
              <h3 className={cn(
                "relative font-semibold leading-tight tracking-[-0.025em] text-white",
                compactIdlePresentation ? "text-xl" : portrait ? "text-[19px]" : "text-[15px]",
              )}>
                {sessionHeadline}
              </h3>
              {listening && statusLabel && !compactIdlePresentation && (
                <span className="relative mt-3 inline-flex items-center gap-1.5 rounded-full bg-white/[0.06] px-2.5 py-1 text-[11px] font-medium text-white/70">
                  <span className="relative flex h-1.5 w-1.5">
                    <span className="ms-dot-pulse absolute inset-0 rounded-full bg-blue-400" />
                    <span className="relative h-1.5 w-1.5 rounded-full bg-blue-400" />
                  </span>
                  {statusLabel}
                </span>
              )}
              {!compactIdlePresentation && !showPhoneSteps && (
                <p className="relative mt-2 max-w-60 text-[12px] leading-[1.6] text-white/50">
                  {sessionSupportingText}
                </p>
              )}
              {showPhoneSteps && (
                <div
                  className={cn(
                    "relative w-full rounded-2xl border border-white/7 bg-white/[0.03] text-left",
                    portrait ? "mt-6 max-w-64 px-4 py-3" : "mt-3 max-w-130 px-3 py-2",
                  )}
                >
                  <p className="text-[10px] font-semibold uppercase tracking-[0.1em] text-white/40">On your iPhone</p>
                  <ol className={cn("mt-1", !portrait && "grid grid-cols-3")}>
                    {phoneSteps.map((step, i) => (
                      <li
                        key={i}
                        className={cn(
                          "flex items-center gap-3",
                          portrait
                            ? "min-h-10 border-b border-white/6 py-2 last:border-b-0"
                            : "min-h-7 border-r border-white/6 px-3 py-1.5 first:pl-0 last:border-r-0 last:pr-0",
                        )}
                      >
                        <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-blue-500/15 text-[11px] font-semibold tabular-nums text-blue-200">
                          {i + 1}
                        </span>
                        <span className="text-[13px] font-medium text-white/85">{step}</span>
                      </li>
                    ))}
                  </ol>
                </div>
              )}
              {!compactIdlePresentation && (isIdle || !isLive || bonjourNeedsAttention) && (
                <button
                  type="button"
                  className={cn(
                    "relative inline-flex items-center justify-center gap-2 font-semibold tracking-[-0.01em] transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-400/60 disabled:cursor-default disabled:opacity-40",
                    portrait ? "mt-6" : "mt-3",
                    primaryIsStart
                      ? "h-9 rounded-full bg-blue-500 px-5 text-[13px] text-white hover:bg-blue-400 active:bg-blue-600"
                      : "h-8 rounded-lg px-3 text-[12px] text-white/50 hover:bg-white/6 hover:text-white/85",
                  )}
                  onClick={onPrimary}
                  disabled={primarySessionActionDisabled}
                >
                  {primarySessionActionLabel}
                </button>
              )}
              {primaryIsStart && !compactIdlePresentation && portrait && (
                <p className="relative mt-4 text-[11px] text-white/30">iPhone and PC must share a Wi-Fi network.</p>
              )}
            </div>
          )}
        </div>
      </div>
      {isRec && (
        <div
          className={cn(
            "absolute right-3.5 top-3 z-30 inline-flex items-center gap-1.5 rounded-full border bg-black/75 px-2.5 py-1 text-[11px] font-semibold tracking-[0.02em] tabular-nums",
            recording.paused ? "border-amber-400/30 text-amber-200" : "border-red-500/30 text-red-300",
          )}
        >
          <span className={cn("h-1.5 w-1.5 rounded-full", recording.paused ? "bg-amber-400" : "animate-pulse bg-red-500")} />
          {recording.paused ? "PAUSED" : "REC"} {fmtDuration(recElapsed)}
          {recording.bytes > 0 && <span className="font-medium text-white/50">· {fmtBytes(recording.bytes)}</span>}
        </div>
      )}
    </div>
  );
}
