import type { MouseEvent } from "react";

import { getCurrentWindow } from "@tauri-apps/api/window";

import { Icon } from "./Icon";

export function WindowControls() {
  const win = getCurrentWindow();

  return (
    <div className="flex shrink-0 items-center">
      <button
        className="inline-flex h-7 w-8 items-center justify-center text-white/48 transition hover:bg-white/6 hover:text-white"
        aria-label="Minimize"
        onClick={() => void win.minimize()}
      >
        <Icon name="minimize" size={11} />
      </button>
      <button
        className="inline-flex h-7 w-8 items-center justify-center text-white/48 transition hover:bg-white/6 hover:text-white"
        aria-label="Maximize"
        onClick={() => void win.toggleMaximize()}
      >
        <Icon name="maximize" size={10} />
      </button>
      <button
        className="inline-flex h-7 w-9 items-center justify-center text-white/48 transition hover:bg-[#c42b1c] hover:text-white"
        aria-label="Close"
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