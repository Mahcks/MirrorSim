import type { MouseEvent, ReactNode, RefObject } from "react";

import type { Orientation } from "@/features/mirrorsim/types";

import { Icon } from "./Icon";
import { WindowControls } from "./WindowControls";

type MinimalViewProps = {
  canCapture: boolean;
  canRecord: boolean;
  commandPending: boolean;
  contextMenu: ReactNode;
  deviceFrame: ReactNode;
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
  settingsModal: ReactNode;
  shellWidth: number;
  titlebarStateDotClass: string;
  titlebarStateLabel: string;
};

export function MinimalView({
  canCapture,
  canRecord,
  commandPending,
  contextMenu,
  deviceFrame,
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
  settingsModal,
  shellWidth,
  titlebarStateDotClass,
  titlebarStateLabel,
}: MinimalViewProps) {
  return (
    <div className="flex h-screen w-screen flex-col items-center overflow-hidden bg-transparent text-white">
      <div ref={minimalShellRef} className="inline-flex flex-col" style={{ width: shellWidth }}>
        <div
          className="flex h-10 w-full shrink-0 items-center justify-between border-b border-white/8 bg-[#17191d] px-2"
          onMouseDown={(event) => void onStartWindowDrag(event)}
        >
          <div className="flex items-center gap-2">
            <WindowControls />
            <div className="flex items-center gap-2 leading-none">
              <span className={titlebarStateDotClass} title={titlebarStateLabel} />
              <span className="select-none text-[11px] font-semibold tracking-[-0.015em] text-white/90">{titlebarStateLabel}</span>
              {reconnectBadge}
            </div>
          </div>
          <div className="flex items-center gap-0.5" onMouseDown={(event) => event.stopPropagation()}>
            <button
              type="button"
              className={minimalFloatingButtonClass}
              onClick={onCapture}
              disabled={!canCapture || commandPending}
              title="Screenshot (⌘S)"
            >
              <Icon name="camera" size={14} />
            </button>
            <button
              type="button"
              className={`${minimalFloatingButtonClass}${isRec ? " bg-red-500/15 text-red-300 hover:bg-red-500/20" : ""}`}
              onClick={onRecordToggle}
              disabled={!canRecord || commandPending}
              title="Toggle recording (⌘R)"
            >
              <Icon name="record" size={14} />
            </button>
            <button type="button" className={minimalFloatingButtonClass} onClick={onRotate} title="Rotate device">
              <Icon name="rotate" size={14} />
            </button>
            <button type="button" className={minimalFloatingButtonClass} onClick={onOpenSettings} title="Screenshot settings">
              <Icon name="settings" size={14} />
            </button>
            <button type="button" className={minimalFloatingButtonClass} onClick={onFit} title="Snap window to fit phone">
              <Icon name="compress" size={14} />
            </button>
            <button
              type="button"
              className="inline-flex h-7 w-7 items-center justify-center text-cyan-300 transition hover:text-white"
              onClick={onGoConsole}
              title="Switch to Console view (⌘M)"
            >
              <Icon name="console" size={12} />
            </button>
          </div>
        </div>

        {deviceFrame}
      </div>

      {contextMenu}
      {settingsModal}
    </div>
  );
}