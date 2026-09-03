import { getCurrentWindow } from "@tauri-apps/api/window";
import { useEffect, useRef } from "react";

import type { Capture, ContextMenuPos } from "@/features/mirrorsim/types";

type MinimalContextMenuProps = {
  canCapture: boolean;
  canRecord: boolean;
  chromeHidden: boolean;
  contextMenu: ContextMenuPos | null;
  isRec: boolean;
  latestSavedCapture?: Capture;
  onCapture: () => void;
  onClose: () => void;
  onCopyToClipboard: () => void;
  onGoConsole: () => void;
  onOpenInExplorer: () => void;
  onOpenSettings: () => void;
  onRecordToggle: () => void;
  onSaveToDocuments: () => void;
  onToggleChrome: () => void;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onZoomReset: () => void;
  zoomCanIncrease: boolean;
  zoomCanDecrease: boolean;
};

export function MinimalContextMenu({
  canCapture,
  canRecord,
  chromeHidden,
  contextMenu,
  isRec,
  latestSavedCapture,
  onCapture,
  onClose,
  onCopyToClipboard,
  onGoConsole,
  onOpenInExplorer,
  onOpenSettings,
  onRecordToggle,
  onSaveToDocuments,
  onToggleChrome,
  onZoomIn,
  onZoomOut,
  onZoomReset,
  zoomCanIncrease,
  zoomCanDecrease,
}: MinimalContextMenuProps) {
  const menuRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (contextMenu) {
      menuRef.current?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
    }
  }, [contextMenu]);

  if (!contextMenu) {
    return null;
  }

  return (
    <div
      ref={menuRef}
      role="menu"
      aria-label="MirrorSim actions"
      className="fixed z-200 min-w-49 rounded-xl border border-white/12 bg-[#1e2023] p-1 shadow-[0_16px_48px_rgba(0,0,0,0.56),0_4px_12px_rgba(0,0,0,0.32)]"
      style={{
        left: Math.max(8, Math.min(contextMenu.x, window.innerWidth - 212)),
        top: Math.max(8, Math.min(contextMenu.y, window.innerHeight - 420)),
      }}
      onPointerDown={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          onClose();
          return;
        }
        if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
          return;
        }
        event.preventDefault();
        const buttons = Array.from(menuRef.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? []);
        if (buttons.length === 0) return;
        const currentIndex = buttons.indexOf(document.activeElement as HTMLButtonElement);
        const nextIndex = event.key === "Home"
          ? 0
          : event.key === "End"
            ? buttons.length - 1
            : event.key === "ArrowDown"
              ? (currentIndex + 1 + buttons.length) % buttons.length
              : (currentIndex - 1 + buttons.length) % buttons.length;
        buttons[nextIndex]?.focus();
      }}
    >
      <button
        type="button"
        className="flex w-full items-center rounded-[5px] px-2.5 py-1.5 text-left text-xs tracking-[-0.01em] text-white transition hover:bg-white/8 disabled:cursor-default disabled:text-white/25"
        onClick={() => {
          onCapture();
          onClose();
        }}
        disabled={!canCapture}
      >
        Take Screenshot
      </button>
      <button
        type="button"
        className="flex w-full items-center rounded-[5px] px-2.5 py-1.5 text-left text-xs tracking-[-0.01em] text-white transition hover:bg-white/8 disabled:cursor-default disabled:text-white/25"
        onClick={() => {
          onCopyToClipboard();
          onClose();
        }}
        disabled={!canCapture}
      >
        Copy to Clipboard
      </button>
      <div className="my-1 h-px bg-white/7" />
      <button
        type="button"
        className="flex w-full items-center rounded-[5px] px-2.5 py-1.5 text-left text-xs tracking-[-0.01em] text-white transition hover:bg-white/8 disabled:cursor-default disabled:text-white/25"
        onClick={() => {
          onRecordToggle();
          onClose();
        }}
        disabled={!canRecord}
      >
        {isRec ? "Stop Recording" : "Start Recording"}
      </button>
      <div className="my-1 h-px bg-white/7" />
      <button
        type="button"
        className="flex w-full items-center rounded-[5px] px-2.5 py-1.5 text-left text-xs tracking-[-0.01em] text-white transition hover:bg-white/8 disabled:cursor-default disabled:text-white/25"
        onClick={() => {
          onSaveToDocuments();
          onClose();
        }}
        disabled={!canCapture}
      >
        Save to Documents
      </button>
      <button
        type="button"
        className="flex w-full items-center rounded-[5px] px-2.5 py-1.5 text-left text-xs tracking-[-0.01em] text-white transition hover:bg-white/8 disabled:cursor-default disabled:text-white/25"
        onClick={() => {
          onOpenInExplorer();
          onClose();
        }}
        disabled={!latestSavedCapture?.filePath}
      >
        Show in File Explorer
      </button>
      <div className="my-1 h-px bg-white/7" />
      <button
        type="button"
        className="flex w-full items-center rounded-[5px] px-2.5 py-1.5 text-left text-xs tracking-[-0.01em] text-white transition hover:bg-white/8 disabled:cursor-default disabled:text-white/25"
        onClick={() => {
          onZoomIn();
          onClose();
        }}
        disabled={!zoomCanIncrease}
      >
        Zoom In
      </button>
      <button
        type="button"
        className="flex w-full items-center rounded-[5px] px-2.5 py-1.5 text-left text-xs tracking-[-0.01em] text-white transition hover:bg-white/8 disabled:cursor-default disabled:text-white/25"
        onClick={() => {
          onZoomOut();
          onClose();
        }}
        disabled={!zoomCanDecrease}
      >
        Zoom Out
      </button>
      <button
        type="button"
        className="flex w-full items-center rounded-[5px] px-2.5 py-1.5 text-left text-xs tracking-[-0.01em] text-white transition hover:bg-white/8"
        onClick={() => {
          onZoomReset();
          onClose();
        }}
      >
        Fit to Screen
      </button>
      <button
        type="button"
        className="flex w-full items-center rounded-[5px] px-2.5 py-1.5 text-left text-xs tracking-[-0.01em] text-white transition hover:bg-white/8"
        onClick={() => {
          onToggleChrome();
          onClose();
        }}
      >
        {chromeHidden ? "Show Controls" : "Hide Controls"}
      </button>
      <div className="my-1 h-px bg-white/7" />
      <button
        type="button"
        className="flex w-full items-center rounded-[5px] px-2.5 py-1.5 text-left text-xs tracking-[-0.01em] text-white transition hover:bg-white/8"
        onClick={() => {
          onOpenSettings();
          onClose();
        }}
      >
        Screenshot Settings
      </button>
      <div className="my-1 h-px bg-white/7" />
      <button
        type="button"
        className="flex w-full items-center rounded-[5px] px-2.5 py-1.5 text-left text-xs tracking-[-0.01em] text-white transition hover:bg-white/8"
        onClick={() => {
          onGoConsole();
          onClose();
        }}
      >
        Switch to Console
      </button>
      <div className="my-1 h-px bg-white/7" />
      <button
        type="button"
        className="flex w-full items-center rounded-[5px] px-2.5 py-1.5 text-left text-xs tracking-[-0.01em] text-red-300 transition hover:bg-red-500/15"
        onClick={() => void getCurrentWindow().close()}
      >
        Close
      </button>
    </div>
  );
}
