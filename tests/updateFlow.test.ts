import { describe, expect, test } from "bun:test";

import {
  getUpdatePrimaryAction,
  isUpdateRestartSafe,
} from "../src/features/mirrorsim/updateFlow";

describe("app update flow", () => {
  test("a downloaded update can restart while stopped or listening", () => {
    expect(isUpdateRestartSafe("idle")).toBe(true);
    expect(isUpdateRestartSafe("discovering")).toBe(true);
    expect(getUpdatePrimaryAction({
      updateState: "ready",
      sessionState: "discovering",
      devPreview: false,
    })).toEqual({ kind: "install", label: "Restart to update", disabled: false });
  });

  test("restart is blocked throughout connection, mirroring, and recording", () => {
    for (const sessionState of ["connecting", "mirroring", "recording"] as const) {
      expect(isUpdateRestartSafe(sessionState)).toBe(false);
      expect(getUpdatePrimaryAction({
        updateState: "ready",
        sessionState,
        devPreview: false,
      }).disabled).toBe(true);
    }
  });

  test("download failures remain retryable without interrupting a live session", () => {
    expect(getUpdatePrimaryAction({
      updateState: "available",
      sessionState: "recording",
      devPreview: false,
    })).toEqual({ kind: "download", label: "Retry download", disabled: false });
  });

  test("downloading and installing cannot be triggered twice", () => {
    expect(getUpdatePrimaryAction({
      updateState: "downloading",
      sessionState: "idle",
      devPreview: false,
    }).disabled).toBe(true);
    expect(getUpdatePrimaryAction({
      updateState: "installing",
      sessionState: "idle",
      devPreview: false,
    }).disabled).toBe(true);
  });

  test("dev preview still exposes the live-session safety state", () => {
    expect(getUpdatePrimaryAction({
      updateState: "ready",
      sessionState: "mirroring",
      devPreview: true,
    }).label).toBe("Finish session first");
    expect(getUpdatePrimaryAction({
      updateState: "ready",
      sessionState: "discovering",
      devPreview: true,
    }).label).toBe("Preview only");
  });
});
