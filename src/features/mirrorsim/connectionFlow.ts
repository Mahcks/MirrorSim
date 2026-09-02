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

export type PendingSessionCommand = "start_session" | "reconnect_session" | "stop_session" | null;

type ConnectionPresentationInput = {
  initializing: boolean;
  pendingSessionCommand?: PendingSessionCommand;
  session: SessionSnapshot;
  pairing: PairingSnapshot;
  receiverRuntime: ReceiverRuntimeSnapshot;
  bonjourStatus: BonjourStatusSnapshot;
  receiverDisplayName: string;
};

export function getConnectionPresentation({
  initializing,
  pendingSessionCommand = null,
  session,
  pairing,
  receiverRuntime,
  bonjourStatus,
  receiverDisplayName,
}: ConnectionPresentationInput): ConnectionPresentation {
  const isLive = session.status === "mirroring" || session.status === "recording";
  const isStartingToListen = pendingSessionCommand === "start_session"
    || pendingSessionCommand === "reconnect_session";
  const receiverIsReady = receiverRuntime.state === "ready" || receiverRuntime.state === "streaming";
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

  if (initializing) {
    headline = "Getting things ready";
    supportingText = "MirrorSim is checking this PC for wireless connections.";
    secondaryLabel = "Checking connection setup";
    titlebarLabel = "Getting ready";
    tone = "active";
  } else if (bonjourStatus.status === "unknown") {
    headline = "Could not verify Bonjour";
    supportingText = bonjourStatus.detail;
    secondaryLabel = "Discovery status unknown";
    titlebarLabel = "Check required";
    tone = "warning";
  } else if (bonjourStatus.status === "missing" || bonjourStatus.status === "stopped") {
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
  } else if (isStartingToListen || (session.status === "discovering" && !receiverIsReady)) {
    headline = "Getting ready to listen";
    supportingText = "You can get your iPhone ready while MirrorSim starts listening.";
    secondaryLabel = `Will appear as ${receiverDisplayName}`;
    titlebarLabel = "Starting";
    tone = "active";
  } else if (session.status === "discovering") {
    headline = "Listening for your iPhone";
    supportingText = "MirrorSim is ready for a connection. Finish these steps on your iPhone.";
    secondaryLabel = receiverIdentity ?? `Visible as ${receiverDisplayName}`;
    titlebarLabel = "Listening";
    tone = "active";
  } else if (receiverRuntime.lastError) {
    headline = "Listening stopped";
    supportingText = receiverRuntime.lastError;
    secondaryLabel = "Connection ended";
    titlebarLabel = "Needs attention";
    tone = "warning";
  } else {
    headline = "Mirror your iPhone";
    supportingText = `Start listening, then select ${receiverDisplayName} from Screen Mirroring on your iPhone.`;
    secondaryLabel = "Not listening";
    titlebarLabel = "Not listening";
    tone = "idle";
  }

  const primaryActionLabel = initializing
    ? "Checking..."
    : isStartingToListen
      ? "Starting..."
    : session.status === "idle" && bonjourStatus.status === "missing"
      ? "Install Bonjour"
      : session.status === "idle" && bonjourStatus.status === "stopped"
        ? "Open Services"
        : session.status === "idle" && bonjourStatus.status === "unknown"
          ? "Recheck Bonjour"
          : session.status === "idle"
            ? "Start listening"
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
    showPhoneSteps: (isStartingToListen || session.status === "discovering")
      && pairing.phase === "idle",
    phoneSteps,
    telemetryHint: supportingText,
  };
}
