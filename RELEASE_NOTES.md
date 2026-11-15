# v0.2.1

v0.2.1 fixes a receiver startup failure on some Windows PCs, removes a misaligned camera cutout from the preview and captures, and resolves security advisories in MirrorSim's dependencies.

## Fixes

- **Receiver startup on Windows (#5).** If Windows blocks the receiver's usual network ports (socket error 10013 or a port already in use), MirrorSim now starts on a free port and advertises that port to your iPhone instead of failing with "fgServerStart returned null". Startup errors now name the port and Windows error.
- **Dynamic Island alignment (#10).** MirrorSim no longer draws its own fixed-size island over the mirrored screen or framed screenshots and recordings. The island you see is the one iOS sends, so it always lines up. iOS hides the island when it has nothing to show and in landscape apps, so it can fade in and out, just like on Apple's own AirPlay receivers.
- **Video recovery.** When the video stream loses continuity, the preview now waits for the next full frame and resumes on its own instead of asking you to reconnect Screen Mirroring.

## Diagnostics

- Adds a bounded diagnostics history that records receiver and stream health (not video or audio) and is included in **Preferences > Support** exports. See [PRIVACY.md](https://github.com/Mahcks/MirrorSim/blob/main/PRIVACY.md) for exactly what is kept and how to delete it.

## Security and dependencies

- Updates Vite, rustls, rustls-webpki, webpki-root-certs, tokio and the Tauri updater (which moves Tauri to 2.12 and the build toolchain to Rust 1.90) to resolve published security advisories. Frontend and Rust audits are clean.
- Pins the AirPlayServer v0.5.1 runtime and its published SHA-256 checksum.

## Compatibility

The receiver keeps adapter protocol `0.8.0`; the free-port fallback is an optional capability that MirrorSim turns on. Trusted devices and settings are preserved when updating from v0.2.0.

## Install

Choose one of the attached Windows builds:

- `MirrorSim_*_x64-setup.exe` - recommended NSIS installer.
- `MirrorSim_*_x64_en-US.msi` - MSI package for managed or advanced installations.
- `MirrorSim-portable-*.zip` - portable build with no installation required.

Windows may show a SmartScreen warning because the binaries are updater-signed but are not yet Windows Authenticode-signed. SHA-256 hashes are included in `checksums.txt`, and the GitHub release includes updater artifacts and build-provenance attestations. See MirrorSim's [code signing policy](https://github.com/Mahcks/MirrorSim/blob/main/CODE_SIGNING.md) for the current status and verification details.
