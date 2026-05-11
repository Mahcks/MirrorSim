import { getCurrentWindow } from "@tauri-apps/api/window";

import type { Capture, ContextMenuPos } from "@/features/mirrorsim/types";

type MinimalContextMenuProps = {
  canCapture: boolean;
  canRecord: boolean;
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
  onZoomIn: () => void;
  onZoomOut: () => void;
  onZoomReset: () => void;
  zoomCanIncrease: boolean;
  zoomCanDecrease: boolean;
};

export function MinimalContextMenu({
  canCapture,
  canRecord,
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
  onZoomIn,
  onZoomOut,
  onZoomReset,
  zoomCanIncrease,
  zoomCanDecrease,
}: MinimalContextMenuProps) {
  if (!contextMenu) {
    return null;
  }

  return (
    <div
      className="fixed z-[200] min-w-[196px] rounded-xl border border-white/12 bg-[#1e2023] p-1 shadow-[0_16px_48px_rgba(0,0,0,0.56),0_4px_12px_rgba(0,0,0,0.32)]"
      style={{ left: contextMenu.x, top: contextMenu.y }}
      onPointerDown={(event) => event.stopPropagation()}
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