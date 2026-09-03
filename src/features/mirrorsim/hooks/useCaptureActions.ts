import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";

import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { revealItemInDir } from "@tauri-apps/plugin-opener";

import {
  buildRecordingFileName,
  buildScreenshotFileName,
  fmtError,
  uint8ArrayToBase64,
} from "@/features/mirrorsim/helpers";
import type {
  AppPreferences,
  Capture,
  Orientation,
  RecordingSettings,
  SavedCaptureFile,
  ScreenshotCaptureOverrides,
  ScreenshotSaveLocation,
  ScreenshotSettings,
  SessionSnapshot,
} from "@/features/mirrorsim/types";
import { getRecordingFailureRecovery } from "@/features/mirrorsim/recordingFlow";
import { createCaptureSurface } from "@/features/mirrorsim/captureSurface";
import { getRetainedPreviewFrame } from "@/mockPreviewStream";

type UseCaptureActionsArgs = {
  appPreferences: AppPreferences;
  canCapture: boolean;
  canRecord: boolean;
  isRec: boolean;
  recordingSettings: RecordingSettings;
  screenshotSettings: ScreenshotSettings;
  setCaptures: Dispatch<SetStateAction<Capture[]>>;
  setCaptureNotice: Dispatch<SetStateAction<string | null>>;
  setCommandError: Dispatch<SetStateAction<string | null>>;
  setCommandPending: (pending: boolean) => void;
  setRecordingSettings: Dispatch<SetStateAction<RecordingSettings>>;
  setScreenshotFlashActive: Dispatch<SetStateAction<boolean>>;
  setScreenshotSettings: Dispatch<SetStateAction<ScreenshotSettings>>;
  setSession: Dispatch<SetStateAction<SessionSnapshot>>;
  videoEl: HTMLVideoElement | null;
  orientation: Orientation;
  recordingAudioTrack: MediaStreamTrack | null;
};

type RecordingWriteSession = SavedCaptureFile & {
  recordingId: number;
};

export function useCaptureActions({
  appPreferences,
  canCapture,
  canRecord,
  isRec,
  recordingSettings,
  screenshotSettings,
  setCaptures,
  setCaptureNotice,
  setCommandError,
  setCommandPending,
  setRecordingSettings,
  setScreenshotFlashActive,
  setScreenshotSettings,
  setSession,
  videoEl,
  orientation,
  recordingAudioTrack,
}: UseCaptureActionsArgs) {
  const [recElapsed, setRecElapsed] = useState(0);
  const [localRecordingActive, setLocalRecordingActive] = useState(false);
  const recStartRef = useRef<number | null>(null);
  const recordingStreamRef = useRef<MediaStream | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const recordingWriteSessionRef = useRef<RecordingWriteSession | null>(null);
  const recordingWriteChainRef = useRef<Promise<void>>(Promise.resolve());
  const recordingWriteErrorRef = useRef<unknown>(null);
  const recordingElapsedRef = useRef(0);
  const captureInFlightRef = useRef(false);
  const recordingTransitionRef = useRef(false);
  const recordingRenderCleanupRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    const recorder = mediaRecorderRef.current;
    if (isRec || recordingTransitionRef.current || !recorder) {
      return;
    }

    void finalizeInterruptedRecording("the mirroring session ended");
  }, [isRec]);

  useEffect(() => {
    if (!isRec) {
      recStartRef.current = null;
      if (!localRecordingActive) {
        setRecElapsed(0);
      }
      return;
    }

    if (recStartRef.current === null) {
      recStartRef.current = Date.now();
    }

    const startedAt = recStartRef.current;
    const intervalId = window.setInterval(() => setRecElapsed(Math.floor((Date.now() - startedAt) / 1000)), 1000);
    return () => window.clearInterval(intervalId);
  }, [isRec, localRecordingActive]);

  async function captureVideoFrameBlob(includeDeviceFrame: boolean): Promise<Blob> {
    if (!videoEl) {
      throw new Error("Live preview is not ready for screenshots yet.");
    }

    const retainedFrame = getRetainedPreviewFrame(videoEl);
    const source = retainedFrame?.canvas ?? videoEl;
    const sourceWidth = retainedFrame?.width ?? videoEl.videoWidth;
    const sourceHeight = retainedFrame?.height ?? videoEl.videoHeight;
    if (sourceWidth === 0 || sourceHeight === 0) {
      throw new Error("MirrorSim has not decoded a frame to screenshot yet.");
    }

    const { canvas, draw } = createCaptureSurface(
      source,
      sourceWidth,
      sourceHeight,
      orientation,
      includeDeviceFrame,
    );
    draw();

    const blob = await new Promise<Blob | null>((resolve) => {
      canvas.toBlob(resolve, "image/png");
    });

    if (!blob) {
      throw new Error("Could not encode screenshot image.");
    }

    return blob;
  }

  async function copyScreenshotToClipboard(blob: Blob) {
    const ClipboardItemCtor = window.ClipboardItem;
    if (!navigator.clipboard?.write || !ClipboardItemCtor) {
      throw new Error("Image clipboard is not available in this environment.");
    }

    await navigator.clipboard.write([
      new ClipboardItemCtor({
        [blob.type]: blob,
      }),
    ]);
  }

  async function saveScreenshotToDisk(
    blob: Blob,
    fileName: string,
    location: ScreenshotSaveLocation,
    customDirectory?: string,
  ) {
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const pngBase64 = uint8ArrayToBase64(bytes);
    const normalizedCustomDirectory = customDirectory?.trim() || null;

    return invoke<SavedCaptureFile>("save_screenshot", {
      request: {
        fileName,
        pngBase64,
        location,
        customDirectory: location === "custom" ? normalizedCustomDirectory : null,
      },
    });
  }

  async function chooseScreenshotFolder() {
    const selection = await open({
      directory: true,
      multiple: false,
      defaultPath: screenshotSettings.customSavePath || undefined,
      title: "Choose Screenshot Folder",
    });

    if (typeof selection !== "string") {
      return;
    }

    setScreenshotSettings((previous) => ({
      ...previous,
      saveLocation: "custom",
      customSavePath: selection,
    }));
    setCommandError(null);
  }

  async function chooseRecordingFolder() {
    const selection = await open({
      directory: true,
      multiple: false,
      defaultPath: recordingSettings.customSavePath || undefined,
      title: "Choose Recording Folder",
    });

    if (typeof selection !== "string") {
      return;
    }

    setRecordingSettings((previous) => ({
      ...previous,
      saveLocation: "custom",
      customSavePath: selection,
    }));
    setCommandError(null);
  }

  function getRecordingMimeType(hasAudio: boolean) {
    const candidates = hasAudio
      ? ["video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm"]
      : ["video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm"];

    for (const candidate of candidates) {
      if (typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(candidate)) {
        return candidate;
      }
    }

    return "";
  }

  async function startLocalRecording(fileName: string) {
    if (!videoEl) {
      throw new Error("Live preview is not ready for recording yet.");
    }

    const retainedFrame = getRetainedPreviewFrame(videoEl);
    const previewSource = retainedFrame?.canvas ?? videoEl;
    const sourceWidth = retainedFrame?.width ?? videoEl.videoWidth;
    const sourceHeight = retainedFrame?.height ?? videoEl.videoHeight;
    if (sourceWidth === 0 || sourceHeight === 0) {
      throw new Error("Live preview is not ready for recording yet.");
    }

    if (typeof MediaRecorder === "undefined") {
      throw new Error("Recording is not available in this environment.");
    }

    const previewVideo = videoEl as HTMLVideoElement & { captureStream?: (frameRate?: number) => MediaStream };
    const previewCanvas = retainedFrame?.canvas as (HTMLCanvasElement & {
      captureStream?: (frameRate?: number) => MediaStream;
    }) | undefined;
    let previewCaptureStream: MediaStream | null = null;
    if (recordingSettings.includeDeviceFrame) {
      const { canvas, draw } = createCaptureSurface(
        previewSource,
        sourceWidth,
        sourceHeight,
        orientation,
        true,
      );
      const framedCanvas = canvas as HTMLCanvasElement & { captureStream?: (frameRate?: number) => MediaStream };
      previewCaptureStream = framedCanvas.captureStream?.(30) ?? null;
      let animationFrameId = 0;
      const renderFrame = () => {
        draw();
        animationFrameId = window.requestAnimationFrame(renderFrame);
      };
      renderFrame();
      recordingRenderCleanupRef.current = () => window.cancelAnimationFrame(animationFrameId);
    } else {
      previewCaptureStream = typeof previewCanvas?.captureStream === "function"
        ? previewCanvas.captureStream(30)
        : typeof previewVideo.captureStream === "function"
          ? previewVideo.captureStream()
          : null;
    }
    if (!previewCaptureStream) {
      recordingRenderCleanupRef.current?.();
      recordingRenderCleanupRef.current = null;
      throw new Error("The preview surface cannot be captured for recording here.");
    }
    const includeRecordingAudio = recordingSettings.includeAudio && recordingAudioTrack !== null;
    if (includeRecordingAudio) {
      previewCaptureStream.addTrack(recordingAudioTrack.clone());
    }

    const mimeType = getRecordingMimeType(includeRecordingAudio);
    const mediaRecorder = mimeType
      ? new MediaRecorder(previewCaptureStream, { mimeType })
      : new MediaRecorder(previewCaptureStream);

    let writeSession: RecordingWriteSession;
    try {
      writeSession = await invoke<RecordingWriteSession>("begin_recording_save", {
        request: {
          fileName,
          location: recordingSettings.saveLocation,
          customDirectory:
            recordingSettings.saveLocation === "custom" ? recordingSettings.customSavePath.trim() || null : null,
        },
      });
    } catch (error) {
      previewCaptureStream.getTracks().forEach((track) => track.stop());
      recordingRenderCleanupRef.current?.();
      recordingRenderCleanupRef.current = null;
      throw error;
    }
    recordingWriteSessionRef.current = writeSession;
    recordingWriteChainRef.current = Promise.resolve();
    recordingWriteErrorRef.current = null;
    mediaRecorder.addEventListener("dataavailable", (event) => {
      if (event.data.size > 0) {
        const chunk = event.data;
        recordingWriteChainRef.current = recordingWriteChainRef.current.then(async () => {
          const session = recordingWriteSessionRef.current;
          if (!session) {
            throw new Error("Recording file session ended before its final chunk was written.");
          }
          const bytes = new Uint8Array(await chunk.arrayBuffer());
          await invoke("append_recording_chunk", {
            recordingId: session.recordingId,
            chunkBase64: uint8ArrayToBase64(bytes),
          });
        }).catch((error) => {
          recordingWriteErrorRef.current = error;
        });
      }
    });

    mediaRecorder.start(1000);
    mediaRecorderRef.current = mediaRecorder;
    recordingStreamRef.current = previewCaptureStream;
    setLocalRecordingActive(true);
  }

  async function stopLocalRecording(): Promise<SavedCaptureFile> {
    const mediaRecorder = mediaRecorderRef.current;
    if (!mediaRecorder) {
      throw new Error("Recording was not started in the preview surface.");
    }

    if (mediaRecorder.state !== "inactive") {
      await new Promise<void>((resolve, reject) => {
        const handleStop = async () => {
          cleanup();
          await recordingWriteChainRef.current;
          if (recordingWriteErrorRef.current) {
            reject(recordingWriteErrorRef.current);
            return;
          }
          resolve();
        };
        const handleError = () => {
          cleanup();
          reject(new Error("The recording session failed to finalize."));
        };
        const cleanup = () => {
          mediaRecorder.removeEventListener("stop", handleStop);
          mediaRecorder.removeEventListener("error", handleError);
        };

        mediaRecorder.addEventListener("stop", handleStop, { once: true });
        mediaRecorder.addEventListener("error", handleError, { once: true });
        mediaRecorder.stop();
      });
    } else {
      await recordingWriteChainRef.current;
      if (recordingWriteErrorRef.current) {
        throw recordingWriteErrorRef.current;
      }
    }

    const writeSession = recordingWriteSessionRef.current;
    if (!writeSession) {
      throw new Error("Recording file session is not active.");
    }
    const savedRecording = await invoke<SavedCaptureFile>("finish_recording_save", {
      recordingId: writeSession.recordingId,
    });
    recordingStreamRef.current?.getTracks().forEach((track) => track.stop());
    recordingRenderCleanupRef.current?.();
    recordingRenderCleanupRef.current = null;
    recordingStreamRef.current = null;
    mediaRecorderRef.current = null;
    recordingWriteSessionRef.current = null;
    recordingElapsedRef.current = 0;
    setLocalRecordingActive(false);
    return savedRecording;
  }

  async function abortUnstartedRecording() {
    const recordingId = recordingWriteSessionRef.current?.recordingId;
    recordingStreamRef.current?.getTracks().forEach((track) => track.stop());
    recordingRenderCleanupRef.current?.();
    recordingRenderCleanupRef.current = null;
    recordingStreamRef.current = null;
    mediaRecorderRef.current = null;
    recordingWriteSessionRef.current = null;
    recordingElapsedRef.current = 0;
    setLocalRecordingActive(false);
    if (recordingId !== undefined) {
      await invoke("abort_recording_save", { recordingId });
    }
  }

  function addSavedRecording(savedRecording: SavedCaptureFile, elapsed: number) {
    setCaptures((previous) => [
      ...previous,
      {
        id: crypto.randomUUID(),
        type: "recording",
        name: savedRecording.fileName,
        duration: elapsed,
        addedAt: Date.now(),
        filePath: savedRecording.filePath,
      },
    ]);
  }

  async function finalizeInterruptedRecording(reason: string): Promise<SavedCaptureFile | null> {
    if (
      recordingTransitionRef.current
      || !mediaRecorderRef.current
      || !recordingWriteSessionRef.current
    ) {
      return null;
    }

    recordingTransitionRef.current = true;
    setCommandPending(true);
    setCaptureNotice(`Saving recording because ${reason}...`);
    const elapsed = recStartRef.current === null
      ? Math.max(recElapsed, recordingElapsedRef.current)
      : Math.max(recElapsed, recordingElapsedRef.current, Math.floor((Date.now() - recStartRef.current) / 1000));
    recordingElapsedRef.current = elapsed;

    try {
      const savedRecording = await stopLocalRecording();
      addSavedRecording(savedRecording, elapsed);
      setCaptureNotice(`Saved interrupted recording to ${savedRecording.filePath}`);
      setCommandError(null);
      return savedRecording;
    } catch (error) {
      const message = fmtError(error);
      setCaptureNotice(`Could not finalize the interrupted recording: ${message}`);
      setCommandError(
        `${message} The temporary recording was retained so it is not silently lost.`,
      );
      return null;
    } finally {
      recordingStreamRef.current?.getTracks().forEach((track) => track.stop());
      recordingRenderCleanupRef.current?.();
      recordingRenderCleanupRef.current = null;
      recordingStreamRef.current = null;
      recordingTransitionRef.current = false;
      setCommandPending(false);
    }
  }

  async function revealCaptureInExplorer(capture: Capture | undefined) {
    if (!capture?.filePath) {
      throw new Error("There is no saved screenshot to reveal yet.");
    }

    await revealItemInDir(capture.filePath);
  }

  async function doCapture(overrides: ScreenshotCaptureOverrides = {}) {
    if (!canCapture || captureInFlightRef.current) {
      console.info("[MirrorSim capture] skipped: capture is not available");
      return;
    }

    const captureSettings: ScreenshotSettings = {
      ...screenshotSettings,
      ...overrides,
    };

    if (!captureSettings.saveToDisk && !captureSettings.copyToClipboard) {
      const message = "Enable disk save or clipboard copy in Screenshot Settings first.";
      console.warn("[MirrorSim capture] skipped:", message, captureSettings);
      setCaptureNotice(message);
      setCommandError(message);
      return;
    }

    if (captureSettings.saveToDisk && captureSettings.saveLocation === "custom" && !captureSettings.customSavePath.trim()) {
      const message = "Enter a custom screenshot folder before using the custom save location.";
      console.warn("[MirrorSim capture] skipped:", message, captureSettings);
      setCaptureNotice(message);
      setCommandError(message);
      return;
    }

    captureInFlightRef.current = true;
    setCommandPending(true);
    setCommandError(null);
    setCaptureNotice("Taking screenshot...");

    try {
      const now = new Date();
      const fileName = buildScreenshotFileName(captureSettings, now);
      console.info("[MirrorSim capture] starting screenshot", {
        fileName,
        saveToDisk: captureSettings.saveToDisk,
        copyToClipboard: captureSettings.copyToClipboard,
        saveLocation: captureSettings.saveLocation,
        customSavePath: captureSettings.customSavePath,
      });
      const screenshotBlob = await captureVideoFrameBlob(captureSettings.includeDeviceFrame);
      let savedScreenshot: SavedCaptureFile | null = null;

      if (captureSettings.saveToDisk) {
        savedScreenshot = await saveScreenshotToDisk(
          screenshotBlob,
          fileName,
          captureSettings.saveLocation,
          captureSettings.customSavePath,
        );
        console.info("[MirrorSim capture] screenshot save result", savedScreenshot);
      }

      if (captureSettings.copyToClipboard) {
        await copyScreenshotToClipboard(screenshotBlob);
        console.info("[MirrorSim capture] screenshot copied to clipboard");
      }

      setSession(await invoke<SessionSnapshot>("take_screenshot"));
      if (appPreferences.screenshotFlashEnabled) {
        setScreenshotFlashActive(true);
      }

      if (savedScreenshot?.filePath && appPreferences.autoRevealSavedCaptures) {
        await revealItemInDir(savedScreenshot.filePath);
      }

      const notice = savedScreenshot?.filePath
        ? `Saved screenshot to ${savedScreenshot.filePath}`
        : captureSettings.copyToClipboard
          ? "Copied screenshot to clipboard"
          : "Screenshot finished, but no disk path was returned.";
      setCaptureNotice(notice);

      setCaptures((previous) => [
        ...previous,
        {
          id: crypto.randomUUID(),
          type: "screenshot",
          name: savedScreenshot?.fileName ?? fileName,
          addedAt: Date.now(),
          filePath: savedScreenshot?.filePath,
        },
      ]);
    } catch (error) {
      const message = fmtError(error);
      console.error("[MirrorSim capture] screenshot failed", {
        message,
        settings: captureSettings,
        error,
      });
      setCaptureNotice(`Screenshot failed: ${message}`);
      setCommandError(message);
    } finally {
      captureInFlightRef.current = false;
      setCommandPending(false);
    }
  }

  async function doRecordToggle() {
    const hasRecordingToFinish = recordingWriteSessionRef.current !== null;
    if ((!canRecord && !hasRecordingToFinish) || recordingTransitionRef.current) {
      return;
    }

    recordingTransitionRef.current = true;
    setCommandPending(true);
    setCommandError(null);
    setCaptureNotice(isRec || hasRecordingToFinish ? "Stopping and saving recording..." : "Starting recording...");

    if (isRec || hasRecordingToFinish) {
      const elapsed = isRec
        ? Math.max(recElapsed, recordingElapsedRef.current)
        : recordingElapsedRef.current;
      recordingElapsedRef.current = elapsed;

      try {
        if (isRec) {
          // Keep the local recorder running when the backend refuses to leave
          // recording mode. The user can safely retry instead of losing data.
          setSession(await invoke<SessionSnapshot>("stop_recording"));
        }
        const savedRecording = await stopLocalRecording();
        console.info("[MirrorSim capture] recording save result", savedRecording);

        addSavedRecording(savedRecording, elapsed);
        setCaptureNotice(`Saved recording to ${savedRecording.filePath}`);

        if (recordingSettings.autoReveal || appPreferences.autoRevealSavedCaptures) {
          try {
            await revealItemInDir(savedRecording.filePath);
          } catch (error) {
            setCommandError(`Recording was saved, but File Explorer could not open it: ${fmtError(error)}`);
          }
        }
      } catch (error) {
        // Never abort an established recording here. `finish_recording_save`
        // intentionally retains its temporary file on failure, and keeping the
        // refs allows another Stop/Save attempt when the backend still owns it.
        if (mediaRecorderRef.current?.state === "inactive") {
          recordingStreamRef.current?.getTracks().forEach((track) => track.stop());
          recordingStreamRef.current = null;
        }
        const message = fmtError(error);
        console.error("[MirrorSim capture] recording stop/save failed", {
          message,
          settings: recordingSettings,
          error,
        });
        setCaptureNotice(`Recording could not be saved yet: ${message}`);
        setCommandError(`${message} Retry saving the recording. Its temporary file was not deleted.`);
      } finally {
        recordingTransitionRef.current = false;
        setCommandPending(false);
      }
      return;
    }

    try {
      if (recordingSettings.saveLocation === "custom" && !recordingSettings.customSavePath.trim()) {
        throw new Error("Choose a recording folder before saving to a custom location.");
      }

      console.info("[MirrorSim capture] starting recording", {
        saveLocation: recordingSettings.saveLocation,
        customSavePath: recordingSettings.customSavePath,
        fileNamePrefix: recordingSettings.fileNamePrefix,
      });
      const fileName = buildRecordingFileName(recordingSettings, new Date());
      await startLocalRecording(fileName);
      try {
        setSession(await invoke<SessionSnapshot>("start_recording"));
        setCaptureNotice("Recording started");
      } catch (error) {
        // A local MediaRecorder is already producing data. Finalize that short
        // clip instead of deleting it when the backend state transition fails.
        const elapsed = Math.max(0, recordingElapsedRef.current);
        try {
          const savedRecording = await stopLocalRecording();
          addSavedRecording(savedRecording, elapsed);
          setCaptureNotice(`AirPlay recording could not start, but the captured clip was saved to ${savedRecording.filePath}`);
        } catch (finalizeError) {
          recordingStreamRef.current?.getTracks().forEach((track) => track.stop());
          recordingStreamRef.current = null;
          const message = fmtError(finalizeError);
          setCaptureNotice(`Recording startup failed and the captured clip could not be saved yet: ${message}`);
          setCommandError(`${fmtError(error)} The temporary clip was retained; use Record again to retry saving it.`);
        }
      }
    } catch (error) {
      // If MediaRecorder never started, the empty workspace is safe to remove.
      // Once a recorder exists, preserve it for the retry path above.
      const recovery = getRecordingFailureRecovery("starting", mediaRecorderRef.current !== null);
      if (recovery.abortWorkspace && recordingWriteSessionRef.current) {
        try {
          await abortUnstartedRecording();
        } catch (abortError) {
          console.error("[MirrorSim capture] empty recording cleanup failed", abortError);
        }
      }
      const message = fmtError(error);
      console.error("[MirrorSim capture] recording start failed", {
        message,
        settings: recordingSettings,
        error,
      });
      setCaptureNotice(`Recording failed: ${message}`);
      setCommandError(message);
    } finally {
      recordingTransitionRef.current = false;
      setCommandPending(false);
    }
  }

  return {
    recElapsed,
    localRecordingActive,
    finalizeInterruptedRecording,
    chooseScreenshotFolder,
    chooseRecordingFolder,
    revealCaptureInExplorer,
    doCapture,
    doRecordToggle,
  };
}
