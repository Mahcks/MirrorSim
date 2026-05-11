import type { CSSProperties, MouseEventHandler, WheelEventHandler } from "react";

import { cn } from "@/lib/utils";
import { fmtDuration } from "@/features/mirrorsim/helpers";
import type { AppMode, Orientation, SessionState } from "@/features/mirrorsim/types";

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
  primarySessionActionLabel: string;
  primarySessionActionDisabled: boolean;
  onPrimary: () => void;
  previewDimClass: string;
  previewVideoStyle: CSSProperties;
  tone: "inactive" | "live" | "warning";
  onContextMenu?: MouseEventHandler<HTMLDivElement>;
  onWheel?: WheelEventHandler<HTMLDivElement>;
  setVideoEl: (element: HTMLVideoElement | null) => void;
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
  primarySessionActionLabel,
  primarySessionActionDisabled,
  onPrimary,
  previewDimClass,
  previewVideoStyle,
  tone,
  onContextMenu,
  onWheel,
  setVideoEl,
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
        <div className="absolute left-1/2 top-3 z-10 h-8.25 w-29.5 -translate-x-1/2 rounded-full bg-black shadow-[inset_0_1px_0_rgba(255,255,255,0.04),0_1px_6px_rgba(0,0,0,0.4)]" />
        <div className={screenFrameClass}>
          <div className="absolute inset-0 rounded-inherit bg-black">
            {!isLive && (
              <div className="absolute inset-0 bg-[radial-gradient(ellipse_70%_40%_at_50%_22%,rgba(57,208,255,0.055),transparent),linear-gradient(180deg,#060709_0%,#08090d_55%,#060708_100%)]" />
            )}
            <div className="absolute inset-0 overflow-hidden rounded-inherit">
              <video
                ref={setVideoEl}
                className={cn("h-full w-full object-cover transition-opacity", previewDimClass)}
                style={previewVideoStyle}
                muted
                playsInline
              />
            </div>
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
          {!isLive && (
            <div className="absolute inset-0 z-20 flex flex-col items-center justify-center px-7 py-8 text-center">
              <div className="relative mb-5 flex h-10 w-10 items-center justify-center">
                {(sessionState === "discovering" || sessionState === "connecting") ? (
                  <>
                    <span className="absolute inset-0 animate-ping rounded-full border border-white/10" />
                    <span className="absolute inset-0.75 rounded-full border border-white/8 bg-white/4" />
                    <Icon name="phone" size={14} className="relative text-white/30" />
                  </>
                ) : (
                  <Icon name="phone" size={24} className="text-white/18" />
                )}
              </div>
              <h3 className="text-[14px] font-semibold leading-tight tracking-[-0.022em] text-white/82">
                {sessionHeadline}
              </h3>
              <p className="mt-1.5 max-w-47.5 text-[10px] leading-[1.6] text-white/36">
                {sessionSupportingText}
              </p>
              {sessionState === "discovering" && (
                <ol className="mt-4 w-full max-w-45 space-y-1.5 text-left">
                  {(["Open Control Center", "Tap Screen Mirroring", "Choose MirrorSim"] as const).map((step, i) => (
                    <li key={i} className="flex items-center gap-2.5">
                      <span className="w-3 shrink-0 text-center text-[9px] font-semibold tabular-nums text-white/20">{i + 1}</span>
                      <span className="text-[10px] text-white/42">{step}</span>
                    </li>
                  ))}
                </ol>
              )}
              {(!isLive || bonjourNeedsAttention) && (
                <button
                  type="button"
                  className="mt-5 h-7.5 rounded-lg border border-white/10 bg-white/5 px-4 text-[11px] font-medium tracking-[-0.01em] text-white/58 transition hover:border-white/16 hover:bg-white/8 hover:text-white/82 disabled:cursor-default disabled:opacity-25"
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
