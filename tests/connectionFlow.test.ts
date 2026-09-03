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
    bonjourStatus: { ...initialBonjourStatus, status: "ready", detail: "Built-in discovery is ready." },
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
    expect(result.titlebarLabel).toBe("Stopped");
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

  test("a dropped mirror-data socket is presented as an automatic reconnect", () => {
    const result = presentation({
      session: { ...idleSession, status: "connecting", deviceName: "Max's iPhone" },
      receiverRuntime: {
        ...initialReceiverRuntime,
        state: "ready",
        lastError: "the iPhone interrupted its mirror-data connection; waiting for the existing AirPlay session to resume",
      },
    });

    expect(result.titlebarLabel).toBe("Reconnecting");
    expect(result.headline).toBe("Reconnecting to Max's iPhone");
    expect(result.supportingText).toContain("automatically");
    expect(result.primaryActionLabel).toBe("Disconnect");
  });

  test("pairing verification takes precedence over generic connection copy", () => {
    const result = presentation({
      session: { ...idleSession, status: "connecting" },
      pairing: { ...initialPairingStatus, phase: "verifying", prompt: "Checking trust." },
    });
    expect(result.headline).toBe("Finishing AirPlay verification");
    expect(result.supportingText).toBe("Checking trust.");
  });

  test("discovery failures take precedence over receiver controls", () => {
    const result = presentation({
      bonjourStatus: { ...initialBonjourStatus, status: "missing", detail: "Discovery could not start." },
    });
    expect(result.headline).toBe("AirPlay discovery is unavailable");
    expect(result.primaryActionLabel).toBe("Start listening");
    expect(result.tone).toBe("warning");
  });

  test("a normally stopped advertiser does not look like a setup failure", () => {
    const result = presentation({
      bonjourStatus: {
        ...initialBonjourStatus,
        status: "stopped",
        detail: "Discovery will begin when MirrorSim starts listening.",
      },
    });
    expect(result.headline).toBe("Mirror your iPhone");
    expect(result.primaryActionLabel).toBe("Start listening");
    expect(result.tone).toBe("idle");
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
