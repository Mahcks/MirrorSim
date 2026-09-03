import type { MouseEvent } from "react";

import { getCurrentWindow } from "@tauri-apps/api/window";

import { cn } from "@/lib/utils";

import { Icon } from "./Icon";

export function WindowControls({ compact = false }: { compact?: boolean }) {
  const win = getCurrentWindow();
  const controlClass = "inline-flex h-7 cursor-pointer items-center justify-center text-white/48 transition hover:bg-white/6 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-cyan-300/65";

  function stopTitlebarDrag(event: MouseEvent<HTMLButtonElement | HTMLDivElement>) {
    event.stopPropagation();
  }

  return (
    <div className="flex shrink-0 items-center" onMouseDown={stopTitlebarDrag} onDoubleClick={stopTitlebarDrag}>
      <button
        type="button"
        className={cn(controlClass, compact ? "w-7" : "w-8")}
        aria-label="Minimize"
        data-tooltip="Minimize"
        data-tooltip-align="start"
        onMouseDown={stopTitlebarDrag}
        onClick={() => void win.minimize()}
      >
        <Icon name="minimize" size={11} />
      </button>
      <button
        type="button"
        className={cn(controlClass, compact ? "w-7" : "w-8")}
        aria-label="Maximize"
        data-tooltip="Maximize"
        onMouseDown={stopTitlebarDrag}
        onClick={() => void win.toggleMaximize()}
      >
        <Icon name="maximize" size={10} />
      </button>
      <button
        type="button"
        className={cn(controlClass, compact ? "w-8" : "w-9", "hover:bg-[#c42b1c]")}
        aria-label="Close"
        data-tooltip="Close"
        onMouseDown={stopTitlebarDrag}
        onClick={() => void win.close()}
      >
        <Icon name="close" size={11} />
      </button>
    </div>
  );
}

export async function startWindowDrag(event: MouseEvent<HTMLElement>) {
  if (event.button !== 0) {
    return;
  }

  const window = getCurrentWindow();

  if (event.detail === 2) {
    await window.toggleMaximize();
    return;
  }

  await window.startDragging();
}
