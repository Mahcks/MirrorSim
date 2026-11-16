import type { CaptureBackground, CaptureGradient, CaptureStyle, DeviceFrameColor, Orientation } from "./types";

type CaptureSurface = {
  canvas: HTMLCanvasElement;
  draw: () => void;
};

export type CaptureSurfaceOptions = {
  includeDeviceFrame: boolean;
  style: CaptureStyle;
  /**
   * Leave the area outside the phone transparent when there is no background.
   * Only PNG screenshots can keep it; video always gets an opaque canvas.
   */
  allowTransparency: boolean;
  /** Round the canvas up to even dimensions, which H.264 encoders require. */
  evenDimensions?: boolean;
};

/** Metal band colors: [top, middle, bottom] gradient stops and an edge highlight. */
export const DEVICE_FRAME_COLORS: Record<DeviceFrameColor, { label: string; stops: [string, string, string]; edge: string }> = {
  black: { label: "Black", stops: ["#2a2c31", "#141518", "#08090a"], edge: "rgba(255,255,255,0.14)" },
  silver: { label: "Silver", stops: ["#eef0f2", "#c3c6cb", "#8f9399"], edge: "rgba(255,255,255,0.7)" },
  gold: { label: "Gold", stops: ["#f1dcbd", "#cdb08a", "#9b7e58"], edge: "rgba(255,248,235,0.65)" },
  blue: { label: "Blue", stops: ["#5d7590", "#33465c", "#1b2735"], edge: "rgba(200,220,255,0.3)" },
};

export const CAPTURE_GRADIENTS: Record<CaptureGradient, { label: string; from: string; to: string }> = {
  sunset: { label: "Sunset", from: "#ff7e5f", to: "#feb47b" },
  ocean: { label: "Ocean", from: "#1c92d2", to: "#7ee8fa" },
  aurora: { label: "Aurora", from: "#7f5af0", to: "#2cb67d" },
  blush: { label: "Blush", from: "#f8cdda", to: "#a78bfa" },
  graphite: { label: "Graphite", from: "#3a3f47", to: "#101216" },
};

export const CAPTURE_BACKGROUND_LABELS: Record<CaptureBackground, string> = {
  none: "None",
  color: "Color",
  gradient: "Gradient",
};

/** Space around the phone when a background is drawn, as a share of its shorter side. */
const BACKGROUND_PADDING = 0.14;

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

function fillBackground(context: CanvasRenderingContext2D, width: number, height: number, style: CaptureStyle) {
  if (style.background === "color") {
    context.fillStyle = style.backgroundColor;
  } else {
    const preset = CAPTURE_GRADIENTS[style.gradient];
    const gradient = context.createLinearGradient(0, 0, width, height);
    gradient.addColorStop(0, preset.from);
    gradient.addColorStop(1, preset.to);
    context.fillStyle = gradient;
  }
  context.fillRect(0, 0, width, height);
}

function even(value: number) {
  return value + (value % 2);
}

/**
 * Builds the canvas that screenshots and recordings are drawn from: the raw
 * screen, optionally inside a phone frame, optionally on a background.
 */
export function createCaptureSurface(
  source: CanvasImageSource,
  sourceWidth: number,
  sourceHeight: number,
  orientation: Orientation,
  options: CaptureSurfaceOptions,
): CaptureSurface {
  const { includeDeviceFrame, style, allowTransparency, evenDimensions = false } = options;
  const hasBackground = style.background !== "none";
  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d", { alpha: allowTransparency && !hasBackground });
  if (!context) {
    throw new Error("Could not create the capture canvas.");
  }

  if (!includeDeviceFrame && !hasBackground) {
    canvas.width = evenDimensions ? even(sourceWidth) : sourceWidth;
    canvas.height = evenDimensions ? even(sourceHeight) : sourceHeight;
    return {
      canvas,
      draw: () => context.drawImage(source, 0, 0, canvas.width, canvas.height),
    };
  }

  const portrait = orientation === "portrait";
  const designWidth = portrait ? 393 : 852;
  const designHeight = portrait ? 852 : 393;
  const scale = Math.max(1, portrait ? sourceWidth / designWidth : sourceHeight / designHeight);
  const screenWidth = Math.round(designWidth * scale);
  const screenHeight = Math.round(designHeight * scale);
  const bezel = includeDeviceFrame ? Math.max(9, Math.round(8 * scale)) : 0;
  const deviceWidth = screenWidth + bezel * 2;
  const deviceHeight = screenHeight + bezel * 2;
  const padding = hasBackground ? Math.round(Math.min(deviceWidth, deviceHeight) * BACKGROUND_PADDING) : 0;
  canvas.width = deviceWidth + padding * 2;
  canvas.height = deviceHeight + padding * 2;
  if (evenDimensions) {
    canvas.width = even(canvas.width);
    canvas.height = even(canvas.height);
  }
  // Center the device; even-rounding may add a pixel on one side.
  const originX = Math.floor((canvas.width - deviceWidth) / 2);
  const originY = Math.floor((canvas.height - deviceHeight) / 2);

  const outerRadius = Math.round((portrait ? 52 : 40) * scale);
  const screenRadius = Math.round((portrait ? 46 : 34) * scale);
  const band = Math.max(3, Math.round(3.5 * scale));
  const frame = DEVICE_FRAME_COLORS[style.frameColor];

  return {
    canvas,
    draw: () => {
      if (hasBackground) {
        fillBackground(context, canvas.width, canvas.height, style);
      } else if (allowTransparency) {
        context.clearRect(0, 0, canvas.width, canvas.height);
      } else {
        context.fillStyle = "#000";
        context.fillRect(0, 0, canvas.width, canvas.height);
      }

      if (includeDeviceFrame) {
        if (hasBackground) {
          // Soft shadow so the phone sits on the background.
          context.save();
          context.shadowColor = "rgba(0,0,0,0.35)";
          context.shadowBlur = 28 * scale;
          context.shadowOffsetY = 10 * scale;
          context.fillStyle = "#000";
          roundedRect(context, originX, originY, deviceWidth, deviceHeight, outerRadius);
          context.fill();
          context.restore();
        }

        // Metal band.
        const metal = context.createLinearGradient(0, originY, 0, originY + deviceHeight);
        metal.addColorStop(0, frame.stops[0]);
        metal.addColorStop(0.18, frame.stops[1]);
        metal.addColorStop(1, frame.stops[2]);
        context.fillStyle = metal;
        roundedRect(context, originX, originY, deviceWidth, deviceHeight, outerRadius);
        context.fill();

        // Black glass bezel inside the band.
        context.fillStyle = "#050506";
        roundedRect(
          context,
          originX + band,
          originY + band,
          deviceWidth - band * 2,
          deviceHeight - band * 2,
          Math.max(0, outerRadius - band),
        );
        context.fill();
      } else if (hasBackground) {
        context.save();
        context.shadowColor = "rgba(0,0,0,0.3)";
        context.shadowBlur = 24 * scale;
        context.shadowOffsetY = 8 * scale;
        context.fillStyle = "#000";
        roundedRect(context, originX, originY, screenWidth, screenHeight, screenRadius);
        context.fill();
        context.restore();
      }

      context.save();
      roundedRect(context, originX + bezel, originY + bezel, screenWidth, screenHeight, screenRadius);
      context.clip();
      drawContainedSource(
        context,
        source,
        sourceWidth,
        sourceHeight,
        originX + bezel,
        originY + bezel,
        screenWidth,
        screenHeight,
      );
      context.restore();

      if (includeDeviceFrame) {
        context.strokeStyle = frame.edge;
        context.lineWidth = Math.max(1, scale * 0.75);
        roundedRect(
          context,
          originX + context.lineWidth / 2,
          originY + context.lineWidth / 2,
          deviceWidth - context.lineWidth,
          deviceHeight - context.lineWidth,
          outerRadius,
        );
        context.stroke();
      }

      // Preserve the sender's pixels, including any screen cutout it supplies.
    },
  };
}
