import { useRef } from "react";

import type { PairingSnapshot } from "@/receiverContract";
import { useModalFocus } from "@/features/mirrorsim/hooks/useModalFocus";
import { isPairingModalOpen } from "@/features/mirrorsim/modalFlow";

type PairingModalProps = {
  pairing: PairingSnapshot;
  approvalActionSupported: boolean;
  rememberTrustByDefault: boolean;
  commandPending: boolean;
  embedded?: boolean;
  onConfirmTrust: () => void;
  onCancel: () => void;
};

export function formatPairingDeviceIdentity(deviceId: string) {
  const normalized = deviceId.trim();
  if (normalized.length <= 16) {
    return normalized;
  }

  return `Device identity ending in ${normalized.slice(-8).toUpperCase()}`;
}

export function PairingModal({ pairing, approvalActionSupported, rememberTrustByDefault, commandPending, embedded = false, onConfirmTrust, onCancel }: PairingModalProps) {
  const cancelButtonRef = useRef<HTMLButtonElement | null>(null);
  const open = isPairingModalOpen(pairing.phase);
  const dialogRef = useModalFocus(open, onCancel, cancelButtonRef);

  if (!open) {
    return null;
  }

  const title =
    pairing.phase === "pin-required"
      ? "AirPlay Verification Required"
      : pairing.phase === "awaiting-trust"
        ? "Trust this iPhone"
        : "Pairing Failed";

  const description =
    ((pairing.phase === "pin-required")
      || (pairing.phase === "awaiting-trust" && !approvalActionSupported)
      ? pairing.phase === "pin-required"
        ? "MirrorSim no longer collects AirPlay PIN codes in-app. If this sender requires a code, finish that verification on the sender or cancel and use device trust instead."
        : "This receiver can identify the device, but it cannot wait for trust approval inside MirrorSim yet."
      : null)
    ?? pairing.failureMessage
    ?? pairing.prompt
    ?? (pairing.phase === "pin-required"
      ? "This sender is asking for AirPlay verification outside MirrorSim."
      : pairing.phase === "awaiting-trust"
        ? rememberTrustByDefault
          ? "Approve this pairing request and MirrorSim will remember this iPhone on this PC."
          : "Approve this pairing request for this session only. You can remember the iPhone later from Device Trust."
        : "The receiver rejected the pairing request.");

  return (
    <div
      className={embedded
        ? "absolute inset-0 z-40 flex items-center justify-center bg-black/65 p-5 backdrop-blur-sm"
        : "fixed inset-0 z-260 flex items-center justify-center bg-black/55 p-4 backdrop-blur-sm"
      }
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="mirrorsim-pairing-title"
        aria-describedby="mirrorsim-pairing-description"
        className={embedded
          ? "w-full max-w-70 rounded-3xl border border-white/10 bg-[#17191d] p-4 shadow-[0_24px_72px_rgba(0,0,0,0.52)]"
          : "w-full max-w-100 rounded-3xl border border-white/10 bg-[#17191d] p-5 shadow-[0_28px_96px_rgba(0,0,0,0.58)]"
        }
      >
        <div className="text-[10px] font-semibold uppercase tracking-[0.08em] text-white/35">Pairing</div>
        <h2 id="mirrorsim-pairing-title" className={embedded ? "mt-2 text-[16px] font-semibold tracking-[-0.03em] text-white" : "mt-2 text-xl font-semibold tracking-[-0.03em] text-white"}>{title}</h2>
        {(pairing.deviceName || pairing.deviceId) && (
          <div className={embedded ? "mt-2 min-w-0 text-[12px]" : "mt-2 min-w-0 text-sm"}>
            <div className="break-words font-medium text-white/60">
              {pairing.deviceName ?? "Unknown iPhone"}
            </div>
            {pairing.deviceId ? (
              <div
                className="mt-0.5 truncate font-mono text-[10px] tracking-[-0.01em] text-white/30"
                title={pairing.deviceId}
              >
                {formatPairingDeviceIdentity(pairing.deviceId)}
              </div>
            ) : null}
          </div>
        )}
        <p id="mirrorsim-pairing-description" className={embedded ? "mt-3 break-words text-[12px] leading-5 text-white/55" : "mt-3 break-words text-sm leading-6 text-white/55"}>{description}</p>

        {pairing.phase === "pin-required" && pairing.entryMode === "enter-on-device" && pairing.displayPin && (
          <div className="mt-4 rounded-2xl border border-white/10 bg-black/20 px-4 py-3 text-center">
            <div className="text-[11px] uppercase tracking-[0.12em] text-white/30">Verification Code</div>
            <div className="mt-1 text-3xl font-semibold tracking-[0.28em] text-white">{pairing.displayPin}</div>
          </div>
        )}

        <div className="mt-5 flex flex-wrap justify-end gap-2">
          <button
            ref={cancelButtonRef}
            type="button"
            className="inline-flex items-center rounded-xl border border-white/10 bg-white/6 px-3 py-2 text-[12px] font-medium text-white/70 transition hover:bg-white/10 hover:text-white disabled:cursor-default disabled:opacity-40"
            onClick={onCancel}
            disabled={commandPending}
          >
            {pairing.phase === "failed" ? "Dismiss" : "Cancel"}
          </button>
          {pairing.phase === "awaiting-trust" && pairing.canTrust && (
            <button
              type="button"
              className="inline-flex items-center rounded-xl border border-emerald-400/20 bg-emerald-500/12 px-3 py-2 text-[12px] font-medium text-emerald-200 transition hover:bg-emerald-500/18 disabled:cursor-default disabled:opacity-40"
              onClick={onConfirmTrust}
              disabled={!approvalActionSupported || commandPending}
            >
              {rememberTrustByDefault ? "Allow & Remember" : "Allow this session"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
