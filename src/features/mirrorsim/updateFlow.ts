import type { SessionState } from "./types";

export type AppUpdateState =
  | "idle"
  | "checking"
  | "downloading"
  | "available"
  | "ready"
  | "installing"
  | "disabled";

export type UpdatePrimaryAction = {
  kind: "none" | "download" | "install";
  label: string;
  disabled: boolean;
  title?: string;
};

export function isUpdateRestartSafe(sessionState: SessionState) {
  return sessionState === "idle" || sessionState === "discovering";
}

export function getUpdatePrimaryAction({
  updateState,
  sessionState,
  devPreview,
}: {
  updateState: AppUpdateState;
  sessionState: SessionState;
  devPreview: boolean;
}): UpdatePrimaryAction {
  if (devPreview) {
    if (updateState === "ready" && !isUpdateRestartSafe(sessionState)) {
      return {
        kind: "none",
        label: "Finish session first",
        disabled: true,
        title: "Disconnect the iPhone or finish pairing before restarting to update.",
      };
    }
    return { kind: "none", label: "Preview only", disabled: true };
  }

  if (updateState === "available") {
    return { kind: "download", label: "Retry download", disabled: false };
  }

  if (updateState === "downloading") {
    return { kind: "none", label: "Downloading...", disabled: true };
  }

  if (updateState === "installing") {
    return { kind: "none", label: "Restarting...", disabled: true };
  }

  if (updateState === "ready") {
    if (!isUpdateRestartSafe(sessionState)) {
      return {
        kind: "none",
        label: "Finish session first",
        disabled: true,
        title: "Disconnect the iPhone or finish pairing before restarting to update.",
      };
    }
    return { kind: "install", label: "Restart to update", disabled: false };
  }

  return { kind: "none", label: "Update unavailable", disabled: true };
}
