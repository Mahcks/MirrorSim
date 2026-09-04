# v0.1.6

MirrorSim v0.1.6 modernizes the bundled receiver's media stack and removes its
last non-OSI-approved codec dependency without changing the familiar mirroring,
capture, recording, orientation, or phone-volume experience.

## Highlights

- Replaces Fraunhofer FDK AAC with FFmpeg 8.1.2's LGPL AAC-ELD decoder.
- Keeps iPhone audio, stereo playback, mute, recording audio, and phone-volume
  following working with the new decoder.
- Removes the obsolete MSYS2 runtime dependency from the shipped receiver.
- Pins the immutable AirPlayServer v0.5.0 runtime and its published SHA-256
  checksum.
- Ships a smaller FFmpeg build containing only the AAC and H.264 decoders and
  their required `libavcodec`, `libavutil`, and `libswscale` libraries.

## Licensing and provenance

- The receiver distribution now contains only OSI-approved MIT, BSD, zlib,
  LGPL, and GPL components.
- AirPlayServer's release workflow rejects any return of the removed FDK source
  tree and verifies that FFmpeg was built with GPL, nonfree, and version-3
  components disabled.
- AirPlayServer v0.5.0 includes the exact FFmpeg 8.1.2 source archive, source
  checksum, build configuration, runtime checksum, and GitHub build-provenance
  attestations.
- MirrorSim's packaged notices now describe the actual receiver files and omit
  the removed FDK AAC and MSYS2 components.

## Compatibility

The receiver keeps adapter protocol `0.8.0` and its existing `pcm-audio`,
`sender-volume`, `video-geometry`, `video-sender-state`, and `external-dnssd`
capabilities. Existing trusted-device and application settings are unchanged.
MirrorSim remains a Windows x64 application.

## Install

Choose one of the attached Windows builds:

- `MirrorSim_*_x64-setup.exe` — recommended NSIS installer.
- `MirrorSim_*_x64_en-US.msi` — MSI package for managed or advanced
  installations.
- `MirrorSim-portable-*.zip` — portable build with no installation required.

Windows may show a SmartScreen warning because the binaries are updater-signed
but are not yet Windows Authenticode-signed. SHA-256 hashes are included in
`checksums.txt`, and the GitHub release includes updater artifacts and
build-provenance attestations. See MirrorSim's
[code signing policy](https://github.com/Mahcks/MirrorSim/blob/main/CODE_SIGNING.md)
for current status, release provenance, and verification details.
