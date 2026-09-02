# MirrorSim v0.1.3

MirrorSim v0.1.3 is a reliability and security release focused on real iPhone connections, pairing, preview recovery, recording safety, and dependable updates.

## Highlights

- Keeps the receiver listening after an iPhone disconnects and clearly restores the connection instructions.
- Uses the AirPlay pairing public key as the persistent device identity instead of trusting sender-provided metadata.
- Binds trust approval to the exact receiver session and pairing challenge so stale prompts cannot approve a later request.
- Restarts a crashed receiver with bounded backoff and restores the active listening session automatically.
- Shows explicit initialization, Bonjour, connection, and preview-recovery states with contextual actions.
- Reworks the opening flow around a single “Start listening” action, shows iPhone connection steps immediately, and only reports “Listening” after the receiver is actually ready.
- Makes the device preview fit smaller Console windows and makes zoom work consistently in Minimal mode.
- Keeps Minimal mode's title bar and drag surface spanning the full window when the phone frame is centered inside a wider viewport.

## Fixed

- Interrupted recordings are finalized instead of silently discarded on disconnect or app close, and failed finalization remains retryable with the recovery path reported.
- Screenshot and recording filenames never overwrite an existing capture, even when timestamps collide.
- Recording finalization uses a no-overwrite move rather than filesystem hard links, so custom FAT, exFAT, network, and cloud-backed folders remain supported.
- Preview buffering now evicts only to a decodable keyframe boundary and waits for random access after a full queue drop.
- Oversized receiver messages and H.264 access units are rejected before unbounded allocation.
- Malformed H.264 SPS and Exp-Golomb data is rejected with checked parsing rather than risking overflow or a panic.
- Bonjour detection uses the Windows Service Control Manager API and no longer depends on localized `sc.exe` output.
- Preferences save in order, keep a revisioned fallback through quick closes or native-store failures, and report persistence errors.
- Only one MirrorSim instance can run at a time, preventing competing receiver and registry writers.
- Trust and history registries use durable, atomic replacement with a recoverable backup.
- Pairing preempts Preferences, only one focus trap can be active, and global shortcuts cannot mutate the app behind an open dialog.
- Destructive trusted-device resets and forget actions now require an explicit second confirmation.
- Receiver shutdown cancels pending pairing waits instead of hanging for the full approval timeout.

## Runtime and release integrity

- Moves compressed H.264 directly through the headless sidecar path without unnecessary decode and audio allocation.
- Separates validation, signed artifact construction, and GitHub publishing into least-privilege jobs.
- Pins every GitHub Action to an immutable commit.
- Scans both Rust lockfiles against RustSec during CI, weekly scheduled validation, and every release; the two current `quick-xml` advisories are resolved.
- Cryptographically verifies every generated updater signature against the public key embedded in MirrorSim before publishing.
- Validates the native runtime file inventory, x64 architecture, and protocol handshake before packaging.
- Publishes SHA-256 checksums and GitHub build-provenance attestations with the installer, MSI, portable zip, updater signatures, and updater manifest.

## Install

Choose one of the attached Windows builds:

- `MirrorSim_*_x64-setup.exe` - recommended NSIS installer.
- `MirrorSim_*_x64_en-US.msi` - MSI package for managed or advanced installations.
- `MirrorSim-portable-*.zip` - portable build with no installation required.

Windows may show a SmartScreen warning because the binaries are updater-signed but are not yet backed by a commercial Windows code-signing certificate.

## Requirements

- Windows 10 or Windows 11, 64-bit.
- Bonjour for Windows.
- An iPhone and PC reachable on the same local network.
- Permission for MirrorSim to communicate through Windows Firewall on private networks.

SHA-256 hashes are included in `checksums.txt`. The GitHub release also includes signed updater artifacts, `latest.json`, and build-provenance attestations.
