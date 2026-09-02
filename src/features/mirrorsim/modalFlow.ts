import type { PairingPhase } from "@/receiverContract";

export function isPairingModalOpen(phase: PairingPhase) {
  return phase !== "idle" && phase !== "paired" && phase !== "verifying";
}

export function getModalVisibility(settingsRequested: boolean, pairingPhase: PairingPhase) {
  const pairingOpen = isPairingModalOpen(pairingPhase);
  return {
    pairingOpen,
    settingsOpen: settingsRequested && !pairingOpen,
  };
}
