import type { CSSProperties, MouseEventHandler, ReactNode, WheelEventHandler } from "react";

import { cn } from "@/lib/utils";
import { fmtDuration } from "@/features/mirrorsim/helpers";
import type { AppMode, Orientation, SessionState } from "@/features/mirrorsim/types";
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
  bonjourNeedsAttention: boolean;
  sessionHeadline: string;
  sessionSupportingText: string;
  compactIdlePresentation?: boolean;
  showPhoneSteps: boolean;
  phoneSteps: [string, string, string];
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
  bonjourNeedsAttention,
  sessionHeadline,
  sessionSupportingText,
  compactIdlePresentation = false,
  showPhoneSteps,
  phoneSteps,
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
        <div
          className={cn(
            "absolute z-10 rounded-full bg-black shadow-[inset_0_1px_0_rgba(255,255,255,0.04),0_1px_6px_rgba(0,0,0,0.4)]",
            orientation === "portrait"
              ? "left-1/2 top-3 h-8.25 w-29.5 -translate-x-1/2"
              : "right-3 top-1/2 h-29.5 w-8.25 -translate-y-1/2",
          )}
        />
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
          {!isLive && (
            <div
              className={cn(
                "absolute inset-0 z-20 flex flex-col items-center justify-center text-center",
                orientation === "portrait" ? "px-7 py-8" : "px-10 py-4",
              )}
              aria-live="polite"
            >
              <div
                className={cn(
                  "relative flex items-center justify-center rounded-full border",
                  orientation === "portrait" ? "mb-5 h-14 w-14" : "mb-3 h-10 w-10",
                  (sessionState === "discovering" || sessionState === "connecting")
                    ? "border-cyan-300/15 bg-cyan-300/[0.045] shadow-[0_0_28px_rgba(103,232,249,0.06)]"
                    : "border-white/[0.06] bg-white/[0.025]",
                )}
              >
                {(sessionState === "discovering" || sessionState === "connecting") ? (
                  <>
                    <span className="absolute inset-1 animate-ping rounded-full border border-cyan-200/15" />
                    <span className="absolute inset-2 rounded-full border border-cyan-100/8 bg-cyan-100/[0.025]" />
                    <span className="relative text-cyan-100/55">
                      <Icon name="phone" size={17} />
                    </span>
                  </>
                ) : (
                  <span className="text-white/24">
                    <Icon name="phone" size={21} />
                  </span>
                )}
              </div>
              <h3 className={cn(
                "font-semibold leading-tight tracking-[-0.025em] text-white/90",
                compactIdlePresentation ? "text-xl" : "text-[15px]",
              )}>
                {sessionHeadline}
              </h3>
              {!compactIdlePresentation && (
                <p className="mt-2 max-w-56 text-[11px] leading-[1.65] text-white/48">
                  {sessionSupportingText}
                </p>
              )}
              {showPhoneSteps && (
                <div
                  className={cn(
                    "w-full rounded-xl border border-white/[0.075] bg-white/[0.025] text-left shadow-[inset_0_1px_0_rgba(255,255,255,0.025)]",
                    orientation === "portrait" ? "mt-5 max-w-55 px-3.5 py-3" : "mt-3 max-w-130 px-3 py-2",
                  )}
                >
                  <p className="text-[8px] font-semibold uppercase tracking-[0.14em] text-white/28">On your iPhone</p>
                  <ol className={cn("mt-1.5", orientation === "landscape" && "grid grid-cols-3")}>
                    {phoneSteps.map((step, i) => (
                      <li
                        key={i}
                        className={cn(
                          "flex items-center gap-2.5 py-1.5",
                          orientation === "portrait"
                            ? "min-h-8.5 border-b border-white/[0.055] last:border-b-0"
                            : "min-h-7 border-r border-white/[0.055] px-3 first:pl-0 last:border-r-0 last:pr-0",
                        )}
                      >
                        <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full border border-cyan-200/15 bg-cyan-300/[0.065] text-[9px] font-semibold tabular-nums text-cyan-100/68">
                          {i + 1}
                        </span>
                        <span className="text-[11px] font-medium text-white/68">{step}</span>
                      </li>
                    ))}
                  </ol>
                </div>
              )}
              {!compactIdlePresentation && (isIdle || !isLive || bonjourNeedsAttention) && (
                <button
                  type="button"
                  className={cn(
                    "h-8.5 rounded-lg border px-4 text-[11px] font-semibold tracking-[-0.01em] transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300/55 disabled:cursor-default disabled:opacity-35",
                    orientation === "portrait" ? "mt-5" : "mt-3",
                    isIdle && !bonjourNeedsAttention
                      ? "border-cyan-200/18 bg-cyan-300/10 text-cyan-50/82 hover:border-cyan-100/28 hover:bg-cyan-300/15 hover:text-white"
                      : "border-white/10 bg-white/5 text-white/58 hover:border-white/16 hover:bg-white/8 hover:text-white/82",
                  )}
                  onClick={onPrimary}
                  disabled={primarySessionActionDisabled}
                >
                  {primarySessionActionLabel}
                </button>
              )}
            </div>
          )}
        </div>
      </div>
      {isRec && (
        <div className="absolute right-3.5 top-3 z-30 inline-flex items-center gap-1.5 rounded-full border border-red-500/30 bg-black/75 px-2.5 py-1 text-[11px] font-semibold tracking-[0.02em] text-red-300">
          <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-red-500" />
          REC {fmtDuration(recElapsed)}
        </div>
      )}
    </div>
  );
}
