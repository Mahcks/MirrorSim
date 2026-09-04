# MirrorSim Privacy Statement

Last updated: September 3, 2026

MirrorSim is designed to process mirrored iPhone video and audio locally on the
Windows PC running the application. MirrorSim does not require an account, does
not include advertising or analytics, and does not operate a cloud service that
receives mirrored content.

## Data processed locally

MirrorSim may process the following information on the local PC:

- Live AirPlay video and audio needed to present and record the mirrored screen
- The sender name and protocol identifiers provided by the iPhone during an
  AirPlay session
- Pairing and trusted-device records when the user chooses to remember a device
- Application preferences, receiver identity, capture history, and update state
- Screenshots and recordings that the user explicitly creates
- Operational diagnostics and receiver logs used for troubleshooting

Live media is decoded in local memory. Screenshots and recordings are written
only when requested and remain in the locations selected by the user.

## Network activity

MirrorSim's network activity is limited to:

- AirPlay and mDNS traffic on the local network
- Update checks and release downloads from the MirrorSim GitHub repository
- External GitHub or documentation links that the user chooses to open

MirrorSim does not send usage telemetry, mirrored frames, audio, captures, or
diagnostic exports to the maintainer.

GitHub may independently process connection information when MirrorSim checks
for updates, downloads a release, or opens a GitHub page. GitHub's own privacy
terms apply to those interactions.

## Diagnostics and personal information

Exported diagnostics redact stable device identifiers, trust keys, session IDs,
and pairing challenge IDs by default. Diagnostics can still contain timestamps,
device-provided names, network errors, file paths, or other contextual details.
Review an export before attaching it to a public issue.

Never publish credentials, private keys, pairing secrets, or sensitive screen
content. Suspected security issues should be reported according to
[SECURITY.md](SECURITY.md).

## Retention and deletion

Transient media buffers are released as sessions end and the application shuts
down. Preferences, receiver identity, trust records, and capture history may
remain in MirrorSim's local application data until they are cleared or that
application data is removed. Screenshots and recordings remain on disk until
the user deletes them.

Uninstalling MirrorSim may not remove user-created captures or every item of
local application data. Users should delete captures separately and clear
trusted devices before uninstalling when they do not want those records kept.

## Changes and questions

Material changes to this statement will be committed to the public repository.
For general privacy questions, open a
[GitHub issue](https://github.com/Mahcks/MirrorSim/issues). Do not include
sensitive or security-related information in a public issue.

