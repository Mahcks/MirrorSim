# MirrorSim v0.1.2

MirrorSim v0.1.2 is a focused connection-flow hotfix for returning to a ready state after an iPhone stops mirroring.

## Fixed

- A normal iPhone disconnect now returns MirrorSim to **Listening for your iPhone** instead of leaving an empty preview in the connecting state.
- Connection instructions reappear immediately after the phone disconnects.
- The AirPlay receiver remains active, allowing the same or another iPhone to reconnect without clicking Start AirPlay again.
- The previous phone identity, preview buffer, and pairing state are cleared while the selected receiver access policy remains in effect.
- Disconnects are recorded as normal informational history events rather than stream warnings.

## Install

Choose one of the attached Windows builds:

- `MirrorSim_*_x64-setup.exe` — recommended NSIS installer.
- `MirrorSim_*_x64_en-US.msi` — MSI package for managed or advanced installations.
- `MirrorSim-portable-*.zip` — portable build with no installation required.

Windows may show a SmartScreen warning because the binaries are updater-signed but are not yet backed by a commercial Windows code-signing certificate.

## Requirements

- Windows 10 or Windows 11, 64-bit.
- An iPhone and PC reachable on the same local network.
- Permission for MirrorSim to communicate through Windows Firewall on private networks.

## Verify downloads

SHA-256 hashes for every published artifact are provided in `checksums.txt`. Signed updater artifacts and `latest.json` are included for in-app update support.
