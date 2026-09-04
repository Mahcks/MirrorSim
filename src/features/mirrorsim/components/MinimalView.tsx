import type { MouseEvent, ReactNode, RefObject } from "react";

import { cn } from "@/lib/utils";
import type { KeyboardShortcutMap, Orientation } from "@/features/mirrorsim/types";
import { MINIMAL_TITLEBAR_HEIGHT, MINIMAL_WINDOW_SIZE, type ZoomLevel } from "@/features/mirrorsim/constants";
import { formatKeyboardShortcuts, keyboardShortcutsToAria } from "@/features/mirrorsim/keyboardShortcuts";

import { Icon } from "./Icon";
import { WindowControls } from "./WindowControls";

type MinimalViewProps = {
  canCapture: boolean;
  canRecord: boolean;
  audioAvailable: boolean;
  audioMuted: boolean;
  keyboardShortcuts: KeyboardShortcutMap;
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
  onToggleAudio: () => void;
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
  updateBanner: ReactNode;
  zoom: ZoomLevel;
};

export function MinimalView({
  canCapture,
  canRecord,
  audioAvailable,
  audioMuted,
  keyboardShortcuts,
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
  onToggleAudio,
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
  updateBanner,
  zoom,
  orientation,
}: MinimalViewProps) {
  const shortcutLabel = (action: keyof KeyboardShortcutMap) => formatKeyboardShortcuts(keyboardShortcuts[action]);
  const shortcutAria = (action: keyof KeyboardShortcutMap) => keyboardShortcutsToAria(keyboardShortcuts[action]);
  const scaledDeviceSize = {
    width: Math.ceil(shellWidth * zoom),
    height: Math.ceil((MINIMAL_WINDOW_SIZE[orientation].height - MINIMAL_TITLEBAR_HEIGHT) * zoom),
  };
  const scaledTitlebarHeight = Math.ceil(MINIMAL_TITLEBAR_HEIGHT * zoom);

  return (
    <div className="flex h-screen w-screen flex-col items-center overflow-hidden bg-transparent text-white">
      <div
        className={cn(
          "relative z-100 w-full shrink-0 cursor-grab overflow-visible border-b active:cursor-grabbing",
          chromeHidden ? "border-white/4 bg-[#101114]" : "border-white/8 bg-[#17191d]",
        )}
        style={{ height: scaledTitlebarHeight }}
        onMouseDown={(event) => void onStartWindowDrag(event)}
      >
        {/* The underlay spans the viewport; the reciprocal width keeps the chrome's
            existing zoom behavior after its transform is applied. */}
        <div
          className="@container grid origin-top-left grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-1 px-1.5"
          style={{
            width: `${100 / zoom}%`,
            height: MINIMAL_TITLEBAR_HEIGHT,
            transform: `scale(${zoom})`,
          }}
        >
          {!chromeHidden ? <WindowControls compact /> : <span />}
          <div
            className="flex min-w-0 items-center gap-1.5 overflow-hidden px-0.5"
            role="status"
            aria-live="polite"
            title={titlebarStateLabel}
          >
            <span className={cn("shrink-0", titlebarStateDotClass)} aria-hidden="true" />
            <span className="min-w-0 truncate select-none text-[11px] font-semibold leading-4 tracking-[-0.015em] text-white/90">{titlebarStateLabel}</span>
            {reconnectBadge}
          </div>
          {!chromeHidden && (
            <div className="flex shrink-0 cursor-default items-center" onMouseDown={(event) => event.stopPropagation()}>
              <button
                type="button"
                className={minimalFloatingButtonClass}
                onClick={onCapture}
                disabled={!canCapture || commandPending}
                data-tooltip={canCapture ? `Screenshot (${shortcutLabel("takeScreenshot")})` : "Screenshot available when iPhone video is ready"}
                aria-label="Take screenshot"
                aria-keyshortcuts={shortcutAria("takeScreenshot")}
              >
                <Icon name="camera" size={14} />
              </button>
              <button
                type="button"
                className={`${minimalFloatingButtonClass}${isRec ? " bg-red-500/15 text-red-300 hover:bg-red-500/20" : ""}`}
                onClick={onRecordToggle}
                disabled={!canRecord || commandPending}
                data-tooltip={isRec ? `Stop recording (${shortcutLabel("toggleRecording")})` : canRecord ? `Start recording (${shortcutLabel("toggleRecording")})` : "Recording available when iPhone video is ready"}
                aria-label={isRec ? "Stop recording" : "Start recording"}
                aria-keyshortcuts={shortcutAria("toggleRecording")}
              >
                <Icon name="record" size={14} />
              </button>
              <button
                type="button"
                className={minimalFloatingButtonClass}
                onClick={onToggleAudio}
                disabled={!audioAvailable}
                data-tooltip={!audioAvailable ? "Audio unavailable" : audioMuted ? `Unmute iPhone audio (${shortcutLabel("toggleAudio")})` : `Mute iPhone audio (${shortcutLabel("toggleAudio")})`}
                aria-label={!audioAvailable ? "iPhone audio unavailable" : "Mute iPhone audio"}
                aria-keyshortcuts={shortcutAria("toggleAudio")}
                aria-pressed={audioMuted}
              >
                <Icon name={audioMuted ? "volume-off" : "volume"} size={14} />
              </button>
              <button type="button" className={minimalFloatingButtonClass} onClick={onRotate} data-tooltip="Rotate device" aria-label="Rotate device">
                <Icon name="rotate" size={14} />
              </button>
              <button
                type="button"
                className={cn(minimalFloatingButtonClass, settingsOpen && "bg-cyan-400/12 text-cyan-200 hover:bg-cyan-400/18 hover:text-cyan-100")}
                onClick={onOpenSettings}
                data-tooltip={settingsOpen ? "Close Preferences" : `Open Preferences (${shortcutLabel("openPreferences")})`}
                aria-label={settingsOpen ? "Close Preferences" : "Open Preferences"}
                aria-keyshortcuts={shortcutAria("openPreferences")}
                aria-haspopup="dialog"
                aria-expanded={settingsOpen}
              >
                <Icon name="settings" size={14} />
              </button>
              <button
                type="button"
                className={cn(minimalFloatingButtonClass, "@max-[420px]:hidden")}
                onClick={onFit}
                data-tooltip="Fit window to phone"
                aria-label="Fit window to phone"
              >
                <Icon name="compress" size={14} />
              </button>
              <div className="relative">
                <button
                  type="button"
                  className="inline-flex h-7 w-7 cursor-pointer items-center justify-center text-cyan-300 transition hover:text-white"
                  onClick={onGoConsole}
                  data-tooltip={`Switch to Console (${shortcutLabel("toggleView")})`}
                  data-tooltip-align="end"
                  aria-label="Switch to Console"
                  aria-keyshortcuts={shortcutAria("toggleView")}
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
      </div>

      <div className="flex min-h-0 w-full flex-1 justify-center overflow-hidden">
        <div style={scaledDeviceSize}>
          {/* Keep this ref on the phone only. Fit-to-phone must not measure a
              manually expanded full-width title bar. */}
          <div
            ref={minimalShellRef}
            className="inline-flex origin-top-left transition-transform duration-150"
            style={{ width: shellWidth, transform: `scale(${zoom})` }}
          >
            {deviceFrame}
          </div>
        </div>
      </div>

      {(captureNotice || commandError) && (
        <div className="pointer-events-none fixed bottom-3 left-1/2 z-50 w-[calc(100vw-24px)] max-w-96 -translate-x-1/2">
          <div
            role={commandError ? "alert" : "status"}
            aria-live={commandError ? "assertive" : "polite"}
            className={cn(
              "pointer-events-auto max-h-32 select-text overflow-y-auto whitespace-pre-wrap wrap-break-word rounded-lg border px-3 py-2 text-[11px] font-medium leading-4 shadow-2xl backdrop-blur",
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

      {updateBanner && (
        <div className="fixed right-2 top-12 z-40">
          {updateBanner}
        </div>
      )}

      {contextMenu}
      {settingsModal}
    </div>
  );
}
