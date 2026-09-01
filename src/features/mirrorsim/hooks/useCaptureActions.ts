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
  RecordingSettings,
  SavedCaptureFile,
  ScreenshotCaptureOverrides,
  ScreenshotSaveLocation,
  ScreenshotSettings,
  SessionSnapshot,
} from "@/features/mirrorsim/types";

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
  setCommandPending: Dispatch<SetStateAction<boolean>>;
  setRecordingSettings: Dispatch<SetStateAction<RecordingSettings>>;
  setScreenshotFlashActive: Dispatch<SetStateAction<boolean>>;
  setScreenshotSettings: Dispatch<SetStateAction<ScreenshotSettings>>;
  setSession: Dispatch<SetStateAction<SessionSnapshot>>;
  videoEl: HTMLVideoElement | null;
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
}: UseCaptureActionsArgs) {
  const [recElapsed, setRecElapsed] = useState(0);
  const recStartRef = useRef<number | null>(null);
  const recordingStreamRef = useRef<MediaStream | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const recordingWriteSessionRef = useRef<RecordingWriteSession | null>(null);
  const recordingWriteChainRef = useRef<Promise<void>>(Promise.resolve());
  const recordingWriteErrorRef = useRef<unknown>(null);
  const captureInFlightRef = useRef(false);
  const recordingTransitionRef = useRef(false);

  useEffect(() => {
    return () => {
      const recorder = mediaRecorderRef.current;
      if (recorder && recorder.state !== "inactive") {
        recorder.stop();
      }
      recordingStreamRef.current?.getTracks().forEach((track) => track.stop());
      const recordingId = recordingWriteSessionRef.current?.recordingId;
      if (recordingId !== undefined) {
        void invoke("abort_recording_save", { recordingId });
      }
      recordingStreamRef.current = null;
      mediaRecorderRef.current = null;
      recordingWriteSessionRef.current = null;
    };
  }, []);

  useEffect(() => {
    const recorder = mediaRecorderRef.current;
    if (isRec || recordingTransitionRef.current || !recorder) {
      return;
    }

    if (recorder.state !== "inactive") {
      recorder.stop();
    }
    recordingStreamRef.current?.getTracks().forEach((track) => track.stop());
    const recordingId = recordingWriteSessionRef.current?.recordingId;
    if (recordingId !== undefined) {
      void invoke("abort_recording_save", { recordingId });
    }
    recordingStreamRef.current = null;
    mediaRecorderRef.current = null;
    recordingWriteSessionRef.current = null;
    setCaptureNotice("Recording stopped because the mirroring session ended.");
  }, [isRec, setCaptureNotice]);

  useEffect(() => {
    if (!isRec) {
      recStartRef.current = null;
      setRecElapsed(0);
      return;
    }

    if (recStartRef.current === null) {
      recStartRef.current = Date.now();
    }

    const startedAt = recStartRef.current;
    const intervalId = window.setInterval(() => setRecElapsed(Math.floor((Date.now() - startedAt) / 1000)), 1000);
    return () => window.clearInterval(intervalId);
  }, [isRec]);

  async function captureVideoFrameBlob(): Promise<Blob> {
    if (!videoEl || videoEl.readyState < 2 || videoEl.videoWidth === 0 || videoEl.videoHeight === 0) {
      throw new Error("Live preview is not ready for screenshots yet.");
    }

    const canvas = document.createElement("canvas");
    canvas.width = videoEl.videoWidth;
    canvas.height = videoEl.videoHeight;

    const context = canvas.getContext("2d");
    if (!context) {
      throw new Error("Could not create screenshot canvas.");
    }

    context.drawImage(videoEl, 0, 0, canvas.width, canvas.height);

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

  function getRecordingMimeType() {
    const candidates = ["video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm"];

    for (const candidate of candidates) {
      if (typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(candidate)) {
        return candidate;
      }
    }

    return "";
  }

  async function startLocalRecording(fileName: string) {
    if (!videoEl || videoEl.readyState < 2 || videoEl.videoWidth === 0 || videoEl.videoHeight === 0) {
      throw new Error("Live preview is not ready for recording yet.");
    }

    if (typeof MediaRecorder === "undefined") {
      throw new Error("Recording is not available in this environment.");
    }

    const previewVideo = videoEl as HTMLVideoElement & { captureStream?: () => MediaStream };
    const previewCaptureStream = typeof previewVideo.captureStream === "function" ? previewVideo.captureStream() : null;
    if (!previewCaptureStream) {
      throw new Error("The preview surface cannot be captured for recording here.");
    }

    const mimeType = getRecordingMimeType();
    const mediaRecorder = mimeType
      ? new MediaRecorder(previewCaptureStream, { mimeType })
      : new MediaRecorder(previewCaptureStream);

    const writeSession = await invoke<RecordingWriteSession>("begin_recording_save", {
      request: {
        fileName,
        location: recordingSettings.saveLocation,
        customDirectory:
          recordingSettings.saveLocation === "custom" ? recordingSettings.customSavePath.trim() || null : null,
      },
    });
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
  }

  async function stopLocalRecording(): Promise<SavedCaptureFile> {
    const mediaRecorder = mediaRecorderRef.current;
    if (!mediaRecorder) {
      throw new Error("Recording was not started in the preview surface.");
    }

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

    recordingStreamRef.current?.getTracks().forEach((track) => track.stop());
    recordingStreamRef.current = null;
    mediaRecorderRef.current = null;
    const writeSession = recordingWriteSessionRef.current;
    if (!writeSession) {
      throw new Error("Recording file session is not active.");
    }
    const savedRecording = await invoke<SavedCaptureFile>("finish_recording_save", {
      recordingId: writeSession.recordingId,
    });
    recordingWriteSessionRef.current = null;
    return savedRecording;
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
      const screenshotBlob = await captureVideoFrameBlob();
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
    if (!canRecord || recordingTransitionRef.current) {
      return;
    }

    recordingTransitionRef.current = true;
    setCommandPending(true);
    setCommandError(null);
    setCaptureNotice(isRec ? "Stopping recording..." : "Starting recording...");

    try {
      if (isRec) {
        const elapsed = recElapsed;
        setSession(await invoke<SessionSnapshot>("stop_recording"));
        const savedRecording = await stopLocalRecording();
        console.info("[MirrorSim capture] recording save result", savedRecording);

        if (recordingSettings.autoReveal || appPreferences.autoRevealSavedCaptures) {
          await revealItemInDir(savedRecording.filePath);
        }
        setCaptureNotice(`Saved recording to ${savedRecording.filePath}`);

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
      } else {
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
        setSession(await invoke<SessionSnapshot>("start_recording"));
        setCaptureNotice("Recording started");
      }
    } catch (error) {
      if (!isRec && mediaRecorderRef.current) {
        mediaRecorderRef.current.stop();
      }
      recordingStreamRef.current?.getTracks().forEach((track) => track.stop());
      recordingStreamRef.current = null;
      mediaRecorderRef.current = null;
      const recordingId = recordingWriteSessionRef.current?.recordingId;
      if (recordingId !== undefined) {
        void invoke("abort_recording_save", { recordingId });
      }
      recordingWriteSessionRef.current = null;
      const message = fmtError(error);
      console.error("[MirrorSim capture] recording failed", {
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
    chooseScreenshotFolder,
    chooseRecordingFolder,
    revealCaptureInExplorer,
    doCapture,
    doRecordToggle,
  };
}
