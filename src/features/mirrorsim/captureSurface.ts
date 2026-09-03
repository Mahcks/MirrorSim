import type { Orientation } from "./types";

type CaptureSurface = {
  canvas: HTMLCanvasElement;
  draw: () => void;
};

function roundedRect(
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
) {
  const safeRadius = Math.min(radius, width / 2, height / 2);
  context.beginPath();
  context.roundRect(x, y, width, height, safeRadius);
}

function drawContainedSource(
  context: CanvasRenderingContext2D,
  source: CanvasImageSource,
  sourceWidth: number,
  sourceHeight: number,
  x: number,
  y: number,
  width: number,
  height: number,
) {
  const sourceAspect = sourceWidth / sourceHeight;
  const destinationAspect = width / height;
  const drawWidth = sourceAspect > destinationAspect ? width : height * sourceAspect;
  const drawHeight = sourceAspect > destinationAspect ? width / sourceAspect : height;
  context.fillStyle = "#000";
  context.fillRect(x, y, width, height);
  context.drawImage(
    source,
    x + (width - drawWidth) / 2,
    y + (height - drawHeight) / 2,
    drawWidth,
    drawHeight,
  );
}

export function createCaptureSurface(
  source: CanvasImageSource,
  sourceWidth: number,
  sourceHeight: number,
  orientation: Orientation,
  includeDeviceFrame: boolean,
): CaptureSurface {
  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d", { alpha: false });
  if (!context) {
    throw new Error("Could not create the capture canvas.");
  }

  if (!includeDeviceFrame) {
    canvas.width = sourceWidth;
    canvas.height = sourceHeight;
    return {
      canvas,
      draw: () => context.drawImage(source, 0, 0, canvas.width, canvas.height),
    };
  }

  const designWidth = orientation === "portrait" ? 393 : 852;
  const designHeight = orientation === "portrait" ? 852 : 393;
  const scale = Math.max(
    1,
    orientation === "portrait"
      ? sourceWidth / designWidth
      : sourceHeight / designHeight,
  );
  const screenWidth = Math.round(designWidth * scale);
  const screenHeight = Math.round(designHeight * scale);
  const bezel = Math.max(8, Math.round(6.5 * scale));
  canvas.width = screenWidth + bezel * 2;
  canvas.height = screenHeight + bezel * 2;

  const outerRadius = Math.round((orientation === "portrait" ? 52 : 40) * scale);
  const screenRadius = Math.round((orientation === "portrait" ? 46 : 34) * scale);

  return {
    canvas,
    draw: () => {
      const gradient = context.createLinearGradient(0, 0, 0, canvas.height);
      gradient.addColorStop(0, "#25272c");
      gradient.addColorStop(0.18, "#111214");
      gradient.addColorStop(1, "#070708");
      context.fillStyle = gradient;
      roundedRect(context, 0, 0, canvas.width, canvas.height, outerRadius);
      context.fill();

      context.save();
      roundedRect(context, bezel, bezel, screenWidth, screenHeight, screenRadius);
      context.clip();
      drawContainedSource(
        context,
        source,
        sourceWidth,
        sourceHeight,
        bezel,
        bezel,
        screenWidth,
        screenHeight,
      );
      context.restore();

      context.strokeStyle = "rgba(255,255,255,0.12)";
      context.lineWidth = Math.max(1, scale);
      roundedRect(context, bezel / 2, bezel / 2, canvas.width - bezel, canvas.height - bezel, outerRadius);
      context.stroke();

      context.fillStyle = "#000";
      if (orientation === "portrait") {
        const islandWidth = Math.round(118 * scale);
        const islandHeight = Math.round(33 * scale);
        roundedRect(
          context,
          (canvas.width - islandWidth) / 2,
          bezel + Math.round(7 * scale),
          islandWidth,
          islandHeight,
          islandHeight / 2,
        );
      } else {
        const islandWidth = Math.round(33 * scale);
        const islandHeight = Math.round(118 * scale);
        roundedRect(
          context,
          canvas.width - bezel - islandWidth - Math.round(7 * scale),
          (canvas.height - islandHeight) / 2,
          islandWidth,
          islandHeight,
          islandWidth / 2,
        );
      }
      context.fill();
    },
  };
}
