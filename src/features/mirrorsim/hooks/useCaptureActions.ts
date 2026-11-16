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
import {
  getRecordingFailureRecovery,
  recordingVideoBitsPerSecond,
  resolveRecordingFormat,
  type ResolvedRecordingFormat,
} from "@/features/mirrorsim/recordingFlow";
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
  ensureRecordingAudio: () => Promise<boolean>;
  setRecordingNormalization: (enabled: boolean) => void;
};

type RecordingWriteSession = SavedCaptureFile & {
  recordingId: number;
};

const EMPTY_RECORDING_BACKEND_ERROR = "recording did not produce any media data";

class EmptyRecordingError extends Error {
  constructor() {
    super("The recording captured no video, so there was nothing to save. Try recording again.");
    this.name = "EmptyRecordingError";
  }
}

function isEmptyRecordingError(error: unknown) {
  return String(error instanceof Error ? error.message : error).includes(EMPTY_RECORDING_BACKEND_ERROR);
}

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
  ensureRecordingAudio,
  setRecordingNormalization,
}: UseCaptureActionsArgs) {
  const [recElapsed, setRecElapsed] = useState(0);
  const [localRecordingActive, setLocalRecordingActive] = useState(false);
  /** Seconds left before recording starts, or null when no countdown runs. */
  const [recCountdown, setRecCountdown] = useState<number | null>(null);
  const [recPaused, setRecPaused] = useState(false);
  /** Bytes the recorder has produced so far. */
  const [recBytes, setRecBytes] = useState(0);
  const recStartRef = useRef<number | null>(null);
  const pausedAtRef = useRef<number | null>(null);
  const pausedTotalMsRef = useRef(0);
  const countdownTimerRef = useRef<number | null>(null);
  const startRecordingNowRef = useRef<() => Promise<void>>(async () => {});
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

  /** Recorded time in whole seconds, excluding time spent paused. */
  function currentElapsedSeconds() {
    const startedAt = recStartRef.current;
    if (startedAt === null) {
      return recordingElapsedRef.current;
    }
    const now = pausedAtRef.current ?? Date.now();
    return Math.max(0, Math.floor((now - startedAt - pausedTotalMsRef.current) / 1000));
  }

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

    const intervalId = window.setInterval(() => setRecElapsed(currentElapsedSeconds()), 250);
    return () => window.clearInterval(intervalId);
  }, [isRec, localRecordingActive]);

  // A countdown cannot finish once the iPhone video goes away.
  useEffect(() => {
    if (!canRecord) {
      cancelRecordingCountdown();
    }
  }, [canRecord]);

  useEffect(() => () => {
    cancelRecordingCountdown();
  }, []);

  /** Stops a running countdown. Returns true when one was running. */
  function cancelRecordingCountdown() {
    if (countdownTimerRef.current === null) {
      return false;
    }
    window.clearInterval(countdownTimerRef.current);
    countdownTimerRef.current = null;
    setRecCountdown(null);
    return true;
  }

  function startRecordingCountdown(seconds: number) {
    let remaining = seconds;
    setRecCountdown(remaining);
    setCaptureNotice(`Recording starts in ${remaining}...`);
    countdownTimerRef.current = window.setInterval(() => {
      remaining -= 1;
      if (remaining > 0) {
        setRecCountdown(remaining);
        return;
      }
      cancelRecordingCountdown();
      void startRecordingNowRef.current();
    }, 1000);
  }

  function doRecordPauseToggle() {
    const recorder = mediaRecorderRef.current;
    if (!isRec || !recorder || recordingTransitionRef.current) {
      return;
    }
    if (recorder.state === "recording") {
      recorder.pause();
      pausedAtRef.current = Date.now();
      setRecPaused(true);
      setRecElapsed(currentElapsedSeconds());
      setCaptureNotice("Recording paused");
    } else if (recorder.state === "paused") {
      pausedTotalMsRef.current += Date.now() - (pausedAtRef.current ?? Date.now());
      pausedAtRef.current = null;
      recorder.resume();
      setRecPaused(false);
      setCaptureNotice("Recording resumed");
    }
  }

  function resetRecordingClock() {
    pausedAtRef.current = null;
    pausedTotalMsRef.current = 0;
    setRecPaused(false);
  }

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
      { includeDeviceFrame, style: appPreferences.captureStyle, allowTransparency: true },
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

  async function startLocalRecording(startedAt: Date): Promise<ResolvedRecordingFormat> {
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
    let recordedWidth = sourceWidth;
    let recordedHeight = sourceHeight;
    if (recordingSettings.includeDeviceFrame || appPreferences.captureStyle.background !== "none") {
      const { canvas, draw } = createCaptureSurface(
        previewSource,
        sourceWidth,
        sourceHeight,
        orientation,
        {
          includeDeviceFrame: recordingSettings.includeDeviceFrame,
          style: appPreferences.captureStyle,
          allowTransparency: false,
          evenDimensions: true,
        },
      );
      const framedCanvas = canvas as HTMLCanvasElement & { captureStream?: (frameRate?: number) => MediaStream };
      previewCaptureStream = framedCanvas.captureStream?.(30) ?? null;
      recordedWidth = canvas.width;
      recordedHeight = canvas.height;
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
    const includeRecordingAudio = recordingSettings.includeAudio
      && recordingAudioTrack !== null
      && await ensureRecordingAudio();
    if (includeRecordingAudio) {
      setRecordingNormalization(recordingSettings.normalizeAudio);
      previewCaptureStream.addTrack(recordingAudioTrack.clone());
    }

    const resolved = resolveRecordingFormat(
      recordingSettings.format,
      includeRecordingAudio,
      (mimeType) => MediaRecorder.isTypeSupported(mimeType),
    );
    if (!resolved) {
      previewCaptureStream.getTracks().forEach((track) => track.stop());
      recordingRenderCleanupRef.current?.();
      recordingRenderCleanupRef.current = null;
      throw new Error("This system cannot encode MP4 or WebM recordings.");
    }
    const mediaRecorder = new MediaRecorder(previewCaptureStream, {
      mimeType: resolved.mimeType,
      videoBitsPerSecond: recordingVideoBitsPerSecond(recordedWidth, recordedHeight),
    });
    const fileName = buildRecordingFileName(recordingSettings, startedAt, resolved.format);

    let writeSession: RecordingWriteSession;
    try {
      writeSession = await invoke<RecordingWriteSession>("begin_recording_save", {
        request: {
          fileName,
          format: resolved.format,
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
    resetRecordingClock();
    setRecBytes(0);
    mediaRecorder.addEventListener("dataavailable", (event) => {
      if (event.data.size > 0) {
        const chunk = event.data;
        setRecBytes((previous) => previous + chunk.size);
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
          console.error("[MirrorSim capture] recording chunk write failed", { size: chunk.size, error });
          // Keep the first failure: later chunks fail as a consequence of it.
          recordingWriteErrorRef.current ??= error;
        });
      }
    });

    mediaRecorder.start(1000);
    mediaRecorderRef.current = mediaRecorder;
    recordingStreamRef.current = previewCaptureStream;
    setLocalRecordingActive(true);
    return resolved;
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
    let savedRecording: SavedCaptureFile;
    try {
      savedRecording = await invoke<SavedCaptureFile>("finish_recording_save", {
        recordingId: writeSession.recordingId,
      });
    } catch (error) {
      if (!isEmptyRecordingError(error)) {
        throw error;
      }
      // The backend already discarded the empty file; nothing is left to retry.
      releaseLocalRecording();
      throw new EmptyRecordingError();
    }
    releaseLocalRecording();
    return savedRecording;
  }

  function releaseLocalRecording() {
    recordingStreamRef.current?.getTracks().forEach((track) => track.stop());
    recordingRenderCleanupRef.current?.();
    recordingRenderCleanupRef.current = null;
    recordingStreamRef.current = null;
    mediaRecorderRef.current = null;
    recordingWriteSessionRef.current = null;
    recordingElapsedRef.current = 0;
    resetRecordingClock();
    setLocalRecordingActive(false);
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
    const elapsed = Math.max(recElapsed, recordingElapsedRef.current, currentElapsedSeconds());
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
    if (cancelRecordingCountdown()) {
      setCaptureNotice("Recording canceled");
      return;
    }
    const hasRecordingToFinish = recordingWriteSessionRef.current !== null;
    if ((!canRecord && !hasRecordingToFinish) || recordingTransitionRef.current) {
      return;
    }

    if (!isRec && !hasRecordingToFinish) {
      if (recordingSettings.saveLocation === "custom" && !recordingSettings.customSavePath.trim()) {
        const message = "Choose a recording folder before saving to a custom location.";
        setCaptureNotice(`Recording failed: ${message}`);
        setCommandError(message);
        return;
      }
      setCommandError(null);
      if (recordingSettings.countdownSeconds > 0) {
        startRecordingCountdown(recordingSettings.countdownSeconds);
        return;
      }
      await startRecordingNow();
      return;
    }

    recordingTransitionRef.current = true;
    setCommandPending(true);
    setCommandError(null);
    setCaptureNotice("Stopping and saving recording...");

    const elapsed = isRec
      ? Math.max(recElapsed, recordingElapsedRef.current, currentElapsedSeconds())
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
      if (error instanceof EmptyRecordingError) {
        setCaptureNotice(`Recording failed: ${message}`);
        setCommandError(message);
      } else {
        setCaptureNotice(`Recording could not be saved yet: ${message}`);
        setCommandError(`${message} Retry saving the recording. Its temporary file was not deleted.`);
      }
    } finally {
      recordingTransitionRef.current = false;
      setCommandPending(false);
    }
  }

  async function startRecordingNow() {
    if (!canRecord || recordingTransitionRef.current || recordingWriteSessionRef.current !== null) {
      return;
    }
    recordingTransitionRef.current = true;
    setCommandPending(true);
    setCommandError(null);
    setCaptureNotice("Starting recording...");

    try {
      console.info("[MirrorSim capture] starting recording", {
        saveLocation: recordingSettings.saveLocation,
        customSavePath: recordingSettings.customSavePath,
        fileNamePrefix: recordingSettings.fileNamePrefix,
      });
      const resolved = await startLocalRecording(new Date());
      try {
        setSession(await invoke<SessionSnapshot>("start_recording"));
        setCaptureNotice(
          resolved.fellBack
            ? `Recording started as ${resolved.format.toUpperCase()} because ${recordingSettings.format.toUpperCase()} is not available on this system`
            : "Recording started",
        );
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
  startRecordingNowRef.current = startRecordingNow;

  return {
    recElapsed,
    recCountdown,
    recPaused,
    recBytes,
    cancelRecordingCountdown,
    doRecordPauseToggle,
    localRecordingActive,
    finalizeInterruptedRecording,
    chooseScreenshotFolder,
    chooseRecordingFolder,
    revealCaptureInExplorer,
    doCapture,
    doRecordToggle,
  };
}
