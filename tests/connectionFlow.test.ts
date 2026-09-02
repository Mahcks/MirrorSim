import { describe, expect, test } from "bun:test";

import { getConnectionPresentation } from "../src/features/mirrorsim/connectionFlow";
import { initialBonjourStatus, initialPairingStatus, initialReceiverRuntime } from "../src/receiverContract";
import type { SessionSnapshot } from "../src/features/mirrorsim/types";

const idleSession: SessionSnapshot = {
  status: "idle",
  captureCount: 0,
  deviceName: "Waiting for iPhone",
  currentDeviceId: null,
  currentDeviceModel: null,
  currentDeviceOsName: null,
  currentDeviceOsVersion: null,
  currentDeviceOsBuildVersion: null,
  currentDeviceSourceVersion: null,
  currentDeviceKey: null,
  currentDeviceNickname: null,
  currentDeviceKnown: false,
  currentDeviceTrusted: false,
  currentDeviceBlocked: false,
  currentDeviceBlockedReason: null,
  receiverId: null,
  receiverProtocolVersion: null,
  receiverCapabilities: [],
};

function presentation(overrides: Partial<Parameters<typeof getConnectionPresentation>[0]> = {}) {
  return getConnectionPresentation({
    initializing: false,
    session: idleSession,
    pairing: initialPairingStatus,
    receiverRuntime: initialReceiverRuntime,
    bonjourStatus: { ...initialBonjourStatus, status: "ready", detail: "Bonjour is running." },
    receiverDisplayName: "Demo Phone",
    ...overrides,
  });
}

describe("connection flow presentation", () => {
  test("startup readiness is not presented as ready or listening", () => {
    const result = presentation({ initializing: true });
    expect(result.titlebarLabel).toBe("Getting ready");
    expect(result.primaryActionLabel).toBe("Checking...");
    expect(result.tone).toBe("active");
  });

  test("idle invites the user to listen without receiver jargon", () => {
    const result = presentation();
    expect(result.titlebarLabel).toBe("Not listening");
    expect(result.headline).toBe("Mirror your iPhone");
    expect(result.primaryActionLabel).toBe("Start listening");
    expect(result.supportingText).toContain("Demo Phone");
    expect(result.supportingText).not.toContain("receiver");
  });

  test("receiver startup immediately shows preparation steps", () => {
    const session = { ...idleSession, status: "discovering" as const };
    const priming = presentation({
      session,
      receiverRuntime: { ...initialReceiverRuntime, state: "priming" },
    });
    expect(priming.headline).toBe("Getting ready to listen");
    expect(priming.titlebarLabel).toBe("Starting");
    expect(priming.showPhoneSteps).toBe(true);

    expect(presentation({ session }).titlebarLabel).toBe("Starting");

    const listening = presentation({
      session,
      receiverRuntime: { ...initialReceiverRuntime, state: "ready" },
    });
    expect(listening.headline).toBe("Listening for your iPhone");
    expect(listening.supportingText).toContain("Finish these steps");
    expect(listening.phoneSteps[2]).toBe("Choose Demo Phone");
    expect(listening.showPhoneSteps).toBe(true);
  });

  test("a pending start shows setup instructions before the command returns", () => {
    const result = presentation({ pendingSessionCommand: "start_session" });

    expect(result.titlebarLabel).toBe("Starting");
    expect(result.headline).toBe("Getting ready to listen");
    expect(result.primaryActionLabel).toBe("Starting...");
    expect(result.showPhoneSteps).toBe(true);
  });

  test("a disconnected phone returns to visible listening instructions", () => {
    const result = presentation({
      session: { ...idleSession, status: "discovering" },
      receiverRuntime: { ...initialReceiverRuntime, state: "ready", lastError: null },
    });

    expect(result.titlebarLabel).toBe("Listening");
    expect(result.headline).toBe("Listening for your iPhone");
    expect(result.showPhoneSteps).toBe(true);
    expect(result.primaryActionLabel).toBe("Stop listening");
  });

  test("an attached sender is not labeled live until video arrives", () => {
    const result = presentation({
      session: { ...idleSession, status: "connecting", deviceName: "Max's iPhone" },
    });
    expect(result.headline).toBe("Max's iPhone");
    expect(result.secondaryLabel).toBe("iPhone connected");
    expect(result.tone).not.toBe("live");
  });

  test("pairing verification takes precedence over generic connection copy", () => {
    const result = presentation({
      session: { ...idleSession, status: "connecting" },
      pairing: { ...initialPairingStatus, phase: "verifying", prompt: "Checking trust." },
    });
    expect(result.headline).toBe("Finishing AirPlay verification");
    expect(result.supportingText).toBe("Checking trust.");
  });

  test("Bonjour failures take precedence over receiver controls", () => {
    const result = presentation({
      bonjourStatus: { ...initialBonjourStatus, status: "missing", detail: "Install Bonjour." },
    });
    expect(result.headline).toBe("Bonjour is required");
    expect(result.tone).toBe("warning");
  });

  test("fatal receiver errors remain visible after the session returns idle", () => {
    const result = presentation({
      receiverRuntime: { ...initialReceiverRuntime, lastError: "Receiver process exited." },
    });
    expect(result.headline).toBe("Listening stopped");
    expect(result.supportingText).toBe("Receiver process exited.");
    expect(result.tone).toBe("warning");
  });
});
