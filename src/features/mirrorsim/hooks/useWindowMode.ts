import { useEffect, useRef, type Dispatch, type SetStateAction } from "react";

import { LogicalSize } from "@tauri-apps/api/dpi";
import { getCurrentWindow } from "@tauri-apps/api/window";

import { MINIMAL_TITLEBAR_HEIGHT, MINIMAL_WINDOW_SIZE } from "@/features/mirrorsim/constants";
import { fmtError } from "@/features/mirrorsim/helpers";
import type { AppMode, Orientation } from "@/features/mirrorsim/types";
import type { ZoomLevel } from "@/features/mirrorsim/constants";

type UseWindowModeArgs = {
  appMode: AppMode;
  setAppMode: Dispatch<SetStateAction<AppMode>>;
  orientation: Orientation;
  zoom: ZoomLevel;
  setZoom: Dispatch<SetStateAction<ZoomLevel>>;
  keepMinimalOnTop: boolean;
  useOpaqueWindowBackground: boolean;
  setCommandError: Dispatch<SetStateAction<string | null>>;
};

export function useWindowMode({
  appMode,
  setAppMode,
  orientation,
  zoom,
  setZoom,
  keepMinimalOnTop,
  useOpaqueWindowBackground,
  setCommandError,
}: UseWindowModeArgs) {
  const minimalShellRef = useRef<HTMLDivElement | null>(null);

  function readMinimalShellSize(nextOrientation: Orientation) {
    const baseSize = MINIMAL_WINDOW_SIZE[nextOrientation];
    const fallback = {
      width: Math.ceil(baseSize.width * zoom),
      height: Math.ceil(baseSize.height * zoom),
    };
    const shell = minimalShellRef.current;

    if (!shell) {
      return fallback;
    }

    // MinimalView deliberately keeps the full-width chrome outside this ref.
    // Add its scaled height back without allowing the viewport width into Fit.
    const rect = shell.getBoundingClientRect();
    const measured = {
      width: Math.max(fallback.width, Math.ceil(rect.width)),
      height: Math.max(fallback.height, Math.ceil(rect.height + MINIMAL_TITLEBAR_HEIGHT * zoom)),
    };

    return measured;
  }

  async function fitMinimalWindow(nextOrientation: Orientation) {
    const win = getCurrentWindow();
    const { width, height } = readMinimalShellSize(nextOrientation);

    try {
      await win.setMinSize(null);
    } catch (error) {
      console.error("[MirrorSim] fitMinimalWindow: setMinSize(null) failed", error);
    }

    try {
      await win.setMaxSize(null);
    } catch (error) {
      console.error("[MirrorSim] fitMinimalWindow: setMaxSize(null) failed", error);
    }

    try {
      await win.setSize(new LogicalSize(width, height));
    } catch (error) {
      console.error("[MirrorSim] fitMinimalWindow: setSize failed", error);
      setCommandError(`Fit resize failed: ${fmtError(error)}`);
    }

    try {
      await win.setMinSize(new LogicalSize(width, height));
    } catch (error) {
      console.error("[MirrorSim] fitMinimalWindow: setMinSize(target) failed", error);
    }
  }

  async function goMinimal() {
    setAppMode("minimal");
    setZoom(1);
    await fitMinimalWindow(orientation);
  }

  async function goConsole() {
    setAppMode("console");
    setZoom(1);
    const win = getCurrentWindow();
    try { await win.setMinSize(null); } catch { /* ignore */ }
    try { await win.setMaxSize(null); } catch { /* ignore */ }
    try { await win.setSize(new LogicalSize(860, 720)); } catch { /* ignore */ }
    try { await win.setMinSize(new LogicalSize(700, 580)); } catch { /* ignore */ }
  }

  useEffect(() => {
    void getCurrentWindow().setMinSize(new LogicalSize(700, 580)).catch(() => {});
  }, []);

  useEffect(() => {
    const root = document.documentElement;
    const body = document.body;
    const background = useOpaqueWindowBackground ? "#0e0f11" : "transparent";

    root.style.background = background;
    body.style.background = background;

    return () => {
      root.style.background = "transparent";
      body.style.background = "transparent";
    };
  }, [useOpaqueWindowBackground]);

  useEffect(() => {
    const win = getCurrentWindow();

    void (async () => {
      try {
        await win.setShadow(appMode === "console");
        await win.setAlwaysOnTop(appMode === "minimal" && keepMinimalOnTop);
      } catch {
        // not critical
      }
    })();
  }, [appMode, keepMinimalOnTop]);

  useEffect(() => {
    if (appMode !== "minimal") {
      return;
    }

    let cancelled = false;
    const frameA = window.requestAnimationFrame(() => {
      const frameB = window.requestAnimationFrame(() => {
        if (!cancelled) {
          void fitMinimalWindow(orientation);
        }
      });

      if (cancelled) {
        window.cancelAnimationFrame(frameB);
      }
    });

    return () => {
      cancelled = true;
      window.cancelAnimationFrame(frameA);
    };
  }, [appMode, orientation, zoom]);

  return {
    minimalShellRef,
    fitMinimalWindow,
    goMinimal,
    goConsole,
  };
}
