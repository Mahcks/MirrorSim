import { useMemo } from "react";

import { createCaptureSurface } from "@/features/mirrorsim/captureSurface";
import type { CaptureStyle, Orientation } from "@/features/mirrorsim/types";

const SAMPLE_WIDTH = 393;
const SAMPLE_HEIGHT = 852;

/** A stand-in home screen so the preview reads as a phone. */
function createSampleScreen(): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = SAMPLE_WIDTH;
  canvas.height = SAMPLE_HEIGHT;
  const context = canvas.getContext("2d");
  if (!context) {
    return canvas;
  }
  const wallpaper = context.createLinearGradient(0, 0, SAMPLE_WIDTH, SAMPLE_HEIGHT);
  wallpaper.addColorStop(0, "#3b5ba8");
  wallpaper.addColorStop(0.55, "#8a4f9e");
  wallpaper.addColorStop(1, "#d9905a");
  context.fillStyle = wallpaper;
  context.fillRect(0, 0, SAMPLE_WIDTH, SAMPLE_HEIGHT);
  context.fillStyle = "rgba(255,255,255,0.92)";
  context.font = "600 64px system-ui, sans-serif";
  context.textAlign = "center";
  context.fillText("9:41", SAMPLE_WIDTH / 2, 190);
  context.fillStyle = "rgba(255,255,255,0.28)";
  for (let row = 0; row < 2; row += 1) {
    for (let column = 0; column < 4; column += 1) {
      context.beginPath();
      context.roundRect(38 + column * 84, 560 + row * 96, 64, 64, 16);
      context.fill();
    }
  }
  return canvas;
}

let sampleScreen: HTMLCanvasElement | null = null;

export function CaptureStylePreview({ style, orientation = "portrait" }: { style: CaptureStyle; orientation?: Orientation }) {
  const src = useMemo(() => {
    sampleScreen ??= createSampleScreen();
    const { canvas, draw } = createCaptureSurface(sampleScreen, SAMPLE_WIDTH, SAMPLE_HEIGHT, orientation, {
      includeDeviceFrame: true,
      style,
      allowTransparency: true,
    });
    draw();
    return canvas.toDataURL("image/png");
  }, [orientation, style.background, style.backgroundColor, style.frameColor, style.gradient]);

  return (
    <div
      className="h-[150px] shrink-0 overflow-hidden rounded-xl border border-white/8 bg-[length:12px_12px] bg-[conic-gradient(#2a2c30_25%,#202226_0_50%,#2a2c30_0_75%,#202226_0)]"
      aria-hidden="true"
    >
      <img src={src} alt="" className="block h-full w-auto" draggable={false} />
    </div>
  );
}
