// Encodes GIF frames off the main thread so recording never stutters the UI.
import { applyPalette, GIFEncoder, quantize } from "gifenc";

export type GifWorkerRequest =
  | { type: "frame"; rgba: ArrayBuffer; width: number; height: number; delayMs: number }
  | { type: "finish" };

export type GifWorkerResponse =
  | { type: "progress"; bytes: number }
  | { type: "done"; bytes: ArrayBuffer }
  | { type: "error"; message: string };

const encoder = GIFEncoder();

const scope = self as unknown as { postMessage(message: GifWorkerResponse, transfer: Transferable[]): void };

function post(message: GifWorkerResponse, transfer: Transferable[] = []) {
  scope.postMessage(message, transfer);
}

self.onmessage = (event: MessageEvent<GifWorkerRequest>) => {
  const message = event.data;
  try {
    if (message.type === "frame") {
      const rgba = new Uint8ClampedArray(message.rgba);
      // A palette per frame keeps colors accurate as the screen changes.
      const palette = quantize(rgba, 256);
      const index = applyPalette(rgba, palette);
      encoder.writeFrame(index, message.width, message.height, {
        palette,
        delay: message.delayMs,
      });
      post({ type: "progress", bytes: encoder.bytesView().length });
      return;
    }
    encoder.finish();
    const bytes = encoder.bytes();
    post({ type: "done", bytes: bytes.buffer as ArrayBuffer }, [bytes.buffer as ArrayBuffer]);
  } catch (error) {
    post({ type: "error", message: error instanceof Error ? error.message : String(error) });
  }
};
