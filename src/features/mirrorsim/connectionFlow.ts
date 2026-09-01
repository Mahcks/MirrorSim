import type {
  BonjourStatusSnapshot,
  PairingSnapshot,
  ReceiverRuntimeSnapshot,
} from "@/receiverContract";
import type { SessionSnapshot } from "./types";

export type ConnectionPresentation = {
  headline: string;
  supportingText: string;
  secondaryLabel: string;
  primaryActionLabel: string;
  primaryActionTitle: string;
  titlebarLabel: string;
  tone: "idle" | "active" | "live" | "warning";
  pairingNeedsAttention: boolean;
  pairingInProgress: boolean;
  showPhoneSteps: boolean;
  phoneSteps: [string, string, string];
  telemetryHint: string;
};

type ConnectionPresentationInput = {
  session: SessionSnapshot;
  pairing: PairingSnapshot;
  receiverRuntime: ReceiverRuntimeSnapshot;
  bonjourStatus: BonjourStatusSnapshot;
  receiverDisplayName: string;
};

export function getConnectionPresentation({
  session,
  pairing,
  receiverRuntime,
  bonjourStatus,
  receiverDisplayName,
}: ConnectionPresentationInput): ConnectionPresentation {
  const isLive = session.status === "mirroring" || session.status === "recording";
  const pairingNeedsAttention = pairing.phase === "pin-required"
    || pairing.phase === "awaiting-trust"
    || pairing.phase === "failed";
  const pairingInProgress = pairing.phase === "verifying";
  const receiverIdentity = session.receiverId
    ? `${session.receiverId}${session.receiverProtocolVersion ? ` v${session.receiverProtocolVersion}` : ""}`
    : null;
  const phoneSteps: [string, string, string] = [
    "Open Control Center",
    "Tap Screen Mirroring",
    `Choose ${receiverDisplayName}`,
  ];

  let headline: string;
  let supportingText: string;
  let secondaryLabel: string;
  let titlebarLabel: string;
  let tone: ConnectionPresentation["tone"];

  if (bonjourStatus.status === "missing" || bonjourStatus.status === "stopped") {
    headline = bonjourStatus.status === "missing" ? "Bonjour is required" : "Bonjour service is stopped";
    supportingText = bonjourStatus.detail;
    secondaryLabel = "Network discovery unavailable";
    titlebarLabel = "Setup required";
    tone = "warning";
  } else if (pairing.phase === "pin-required") {
    headline = "AirPlay verification required";
    supportingText = pairing.prompt
      ?? "Finish the verification shown by your iPhone, or cancel this connection attempt.";
    secondaryLabel = pairing.deviceId ?? pairing.deviceName ?? "Verification pending";
    titlebarLabel = "Verification";
    tone = "active";
  } else if (pairing.phase === "awaiting-trust") {
    headline = "Approve this iPhone";
    supportingText = pairing.prompt ?? "Review the iPhone name, then allow or cancel the connection.";
    secondaryLabel = pairing.deviceId ?? pairing.deviceName ?? "Approval pending";
    titlebarLabel = "Approval needed";
    tone = "active";
  } else if (pairing.phase === "verifying") {
    headline = "Finishing AirPlay verification";
    supportingText = pairing.prompt ?? "MirrorSim is completing the secure AirPlay handshake.";
    secondaryLabel = pairing.deviceId ?? pairing.deviceName ?? "Verification in progress";
    titlebarLabel = "Verifying";
    tone = "active";
  } else if (pairing.phase === "failed") {
    headline = "Connection not allowed";
    supportingText = pairing.failureMessage ?? pairing.prompt ?? "The AirPlay connection could not be approved.";
    secondaryLabel = pairing.deviceId ?? pairing.deviceName ?? "Connection rejected";
    titlebarLabel = "Needs attention";
    tone = "warning";
  } else if (isLive) {
    headline = session.currentDeviceNickname ?? session.deviceName;
    supportingText = session.status === "recording"
      ? "Recording your iPhone screen. Stop recording when you are finished."
      : "Your iPhone screen is live in MirrorSim.";
    secondaryLabel = "Connected via AirPlay";
    titlebarLabel = "Connected";
    tone = "live";
  } else if (session.status === "connecting") {
    headline = session.currentDeviceNickname ?? (session.deviceName === "Waiting for iPhone"
      ? "Preparing iPhone preview"
      : session.deviceName);
    supportingText = "The iPhone is connected. MirrorSim is waiting for the first decodable video frame.";
    secondaryLabel = "iPhone connected";
    titlebarLabel = "Connecting";
    tone = "active";
  } else if (session.status === "discovering" && receiverRuntime.state === "priming") {
    headline = "Starting AirPlay receiver";
    supportingText = `MirrorSim is preparing ${receiverDisplayName} for your iPhone.`;
    secondaryLabel = "Receiver starting";
    titlebarLabel = "Starting";
    tone = "active";
  } else if (session.status === "discovering") {
    headline = "Ready for Screen Mirroring";
    supportingText = `On your iPhone, open Control Center, tap Screen Mirroring, then choose ${receiverDisplayName}.`;
    secondaryLabel = receiverIdentity ?? `Listening as ${receiverDisplayName}`;
    titlebarLabel = "Listening";
    tone = "active";
  } else if (receiverRuntime.lastError) {
    headline = "AirPlay receiver stopped";
    supportingText = receiverRuntime.lastError;
    secondaryLabel = "Connection ended";
    titlebarLabel = "Needs attention";
    tone = "warning";
  } else {
    headline = "Ready to mirror";
    supportingText = `Start the AirPlay receiver, then choose ${receiverDisplayName} from your iPhone's Screen Mirroring list.`;
    secondaryLabel = "Receiver stopped";
    titlebarLabel = "Stopped";
    tone = "idle";
  }

  const primaryActionLabel = session.status === "idle"
    ? "Start AirPlay"
    : session.status === "recording"
      ? "Stop recording"
      : session.status === "discovering"
        ? "Stop listening"
        : session.status === "connecting"
          ? "Cancel connection"
          : "Disconnect";

  return {
    headline,
    supportingText,
    secondaryLabel,
    primaryActionLabel,
    primaryActionTitle: primaryActionLabel,
    titlebarLabel,
    tone,
    pairingNeedsAttention,
    pairingInProgress,
    showPhoneSteps: session.status === "discovering"
      && receiverRuntime.state === "ready"
      && pairing.phase === "idle",
    phoneSteps,
    telemetryHint: supportingText,
  };
}
