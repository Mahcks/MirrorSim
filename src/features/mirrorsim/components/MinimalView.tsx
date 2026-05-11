import type { MouseEvent, ReactNode, RefObject } from "react";

import { cn } from "@/lib/utils";
import type { Orientation } from "@/features/mirrorsim/types";

import { Icon } from "./Icon";
import { WindowControls } from "./WindowControls";

type MinimalViewProps = {
  canCapture: boolean;
  canRecord: boolean;
  captureNotice: string | null;
  commandError: string | null;
  commandPending: boolean;
  contextMenu: ReactNode;
  deviceFrame: ReactNode;
  chromeHidden: boolean;
  isRec: boolean;
  minimalFloatingButtonClass: string;
  minimalShellRef: RefObject<HTMLDivElement | null>;
  onCapture: () => void;
  onFit: () => void;
  onGoConsole: () => void;
  onOpenSettings: () => void;
  onRecordToggle: () => void;
  onRotate: () => void;
  onStartWindowDrag: (event: MouseEvent<HTMLElement>) => void | Promise<void>;
  orientation: Orientation;
  reconnectBadge: ReactNode;
  settingsOpen: boolean;
  settingsModal: ReactNode;
  showConsoleBadge: boolean;
  shellWidth: number;
  titlebarStateDotClass: string;
  titlebarStateLabel: string;
};

export function MinimalView({
  canCapture,
  canRecord,
  captureNotice,
  commandError,
  commandPending,
  contextMenu,
  deviceFrame,
  chromeHidden,
  isRec,
  minimalFloatingButtonClass,
  minimalShellRef,
  onCapture,
  onFit,
  onGoConsole,
  onOpenSettings,
  onRecordToggle,
  onRotate,
  onStartWindowDrag,
  reconnectBadge,
  settingsOpen,
  settingsModal,
  showConsoleBadge,
  shellWidth,
  titlebarStateDotClass,
  titlebarStateLabel,
}: MinimalViewProps) {
  return (
    <div className="flex h-screen w-screen flex-col items-center overflow-hidden bg-transparent text-white">
      <div ref={minimalShellRef} className="inline-flex flex-col" style={{ width: shellWidth }}>
        <div
          className={cn(
            "flex h-10 w-full shrink-0 cursor-grab items-center justify-between border-b px-2 active:cursor-grabbing",
            chromeHidden ? "border-white/4 bg-[#101114]" : "border-white/8 bg-[#17191d]",
          )}
          onMouseDown={(event) => void onStartWindowDrag(event)}
        >
          <div className="flex items-center gap-2">
            {!chromeHidden && <WindowControls />}
            <div className="flex items-center gap-2 leading-none">
              <span className={titlebarStateDotClass} title={titlebarStateLabel} />
              <span className="select-none text-[11px] font-semibold tracking-[-0.015em] text-white/90">{titlebarStateLabel}</span>
              {reconnectBadge}
            </div>
          </div>
          {!chromeHidden && (
            <div className="flex cursor-default items-center gap-0.5" onMouseDown={(event) => event.stopPropagation()}>
              <button
                type="button"
                className={minimalFloatingButtonClass}
                onClick={onCapture}
                disabled={!canCapture || commandPending}
                title="Screenshot (Ctrl+S)"
              >
                <Icon name="camera" size={14} />
              </button>
              <button
                type="button"
                className={`${minimalFloatingButtonClass}${isRec ? " bg-red-500/15 text-red-300 hover:bg-red-500/20" : ""}`}
                onClick={onRecordToggle}
                disabled={!canRecord || commandPending}
                title="Record (Ctrl+R)"
              >
                <Icon name="record" size={14} />
              </button>
              <button type="button" className={minimalFloatingButtonClass} onClick={onRotate} title="Rotate device">
                <Icon name="rotate" size={14} />
              </button>
              <button
                type="button"
                className={cn(minimalFloatingButtonClass, settingsOpen && "bg-cyan-400/12 text-cyan-200 hover:bg-cyan-400/18 hover:text-cyan-100")}
                onClick={onOpenSettings}
                title={settingsOpen ? "Close Preferences" : "Open Preferences"}
                aria-pressed={settingsOpen}
              >
                <Icon name="settings" size={14} />
              </button>
              <button type="button" className={minimalFloatingButtonClass} onClick={onFit} title="Fit window to phone">
                <Icon name="compress" size={14} />
              </button>
              <div className="relative">
                <button
                  type="button"
                  className="inline-flex h-7 w-7 cursor-pointer items-center justify-center text-cyan-300 transition hover:text-white"
                  onClick={onGoConsole}
                  title="Switch to Console (Ctrl+M)"
                >
                  <Icon name="console" size={12} />
                </button>
                {showConsoleBadge && (
                  <span className="pointer-events-none absolute right-0.5 top-0.5 h-2 w-2 rounded-full bg-amber-300 shadow-[0_0_0_2px_rgba(23,25,29,0.95)]" />
                )}
              </div>
            </div>
          )}
        </div>

        {deviceFrame}
      </div>

      {(captureNotice || commandError) && (
        <div className="pointer-events-none fixed bottom-3 left-1/2 z-50 max-w-[calc(100vw-24px)] -translate-x-1/2">
          <div
            className={cn(
              "max-w-[360px] truncate rounded-[8px] border px-3 py-2 text-[11px] font-medium shadow-2xl backdrop-blur",
              commandError
                ? "border-red-400/25 bg-red-950/85 text-red-100"
                : "border-emerald-300/20 bg-[#101418]/90 text-emerald-100",
            )}
            title={commandError ?? captureNotice ?? undefined}
          >
            {commandError ?? captureNotice}
          </div>
        </div>
      )}

      {contextMenu}
      {settingsModal}
    </div>
  );
}
