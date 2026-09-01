# MirrorSim v0.1.1

MirrorSim v0.1.1 is a reliability and usability release focused on making the complete AirPlay connection flow predictable—from starting the receiver to approving, connecting, mirroring, recording, and disconnecting an iPhone.

## Highlights

- Clear connection stages for starting, listening, approval, verification, attachment, and live video.
- More reliable receiver startup, shutdown, reconnection, and process cleanup.
- Correct approval behavior across Ask Every Time, Remember Trusted Devices, and Known Devices Only modes.
- Safer handling of rejected, blocked, and unknown devices before media begins.
- Improved capture, screenshot, recording, and session cleanup behavior.
- Better settings safeguards while the receiver is active.
- Hardened release packaging with validated PowerShell scripts and guarded bundle cleanup.
- Expanded automated coverage across the React UI, Tauri application, and native receiver integration.

## Install

Choose one of the attached Windows builds:

- `MirrorSim_*_x64-setup.exe` — recommended NSIS installer.
- `MirrorSim_*_x64_en-US.msi` — MSI package for managed or advanced installations.
- `MirrorSim-*-windows-x64-portable.zip` — portable build with no installation required.

Windows may show a SmartScreen warning because the binaries are updater-signed but are not yet backed by a commercial Windows code-signing certificate.

## Requirements

- Windows 10 or Windows 11, 64-bit.
- An iPhone and PC reachable on the same local network.
- Permission for MirrorSim to communicate through Windows Firewall on private networks.

## Verify downloads

SHA-256 hashes for every published artifact are provided in `checksums.txt`. Signed updater artifacts and `latest.json` are included for in-app update support.
