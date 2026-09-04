# Code Signing Policy

## Status

MirrorSim is evaluating eligibility for the free SignPath Foundation
open-source code-signing program. Until the dependency review and application
are accepted and the release workflow is integrated, MirrorSim's Windows
installer is not Authenticode-signed and Windows SmartScreen may show a warning.

The bundled receiver currently uses Fraunhofer FDK AAC under its own codec
license, which is not listed in the OSI approved-license registry. SignPath's
published terms require OSI-approved licensing for every component. MirrorSim
will disclose this dependency and obtain a written eligibility determination,
or replace/isolate it with an eligible implementation, before requesting
production signatures.

If accepted, the signing provider will be disclosed as follows:

> Free code signing provided by SignPath.io, certificate by SignPath Foundation

MirrorSim's existing Tauri updater signatures authenticate update artifacts to
installed copies of MirrorSim. They are separate from Windows Authenticode code
signing and do not suppress SmartScreen warnings.

## Signing scope and provenance

- Only official MirrorSim Windows release artifacts produced from this public
  repository are eligible for signing.
- Releases originate from a version tag and the pinned GitHub Actions workflow
  in [`.github/workflows/release.yml`](.github/workflows/release.yml).
- The workflow validates the version, builds the application, runs tests and
  audits, emits SHA-256 checksums, and creates GitHub build-provenance
  attestations.
- Every SignPath signing request must be manually approved after the automated
  build and validation steps succeed.
- Signed artifacts must use consistent MirrorSim product and version metadata.

The MirrorSim package includes an AirPlay receiver runtime built from the
[Mahcks/AirPlayServer](https://github.com/Mahcks/AirPlayServer) open-source fork
of [xenos1337/AirPlayServer](https://github.com/xenos1337/AirPlayServer). That
runtime has its own source, license notices, release process, and build
artifacts. MirrorSim will not apply its signing identity to third-party or
upstream binaries as though they were MirrorSim-authored binaries.

## Team roles

MirrorSim is currently maintained by one person:

- Committer and reviewer: [Max (Mahcks)](https://github.com/Mahcks)
- Signing approver: [Max (Mahcks)](https://github.com/Mahcks)

Changes proposed by outside contributors require maintainer review before
merge. Direct maintainer changes are treated as author changes. Repository and
SignPath accounts used for signing must have multi-factor authentication
enabled.

## Privacy and network behavior

MirrorSim's [privacy statement](PRIVACY.md) describes its local media
processing, retained settings, diagnostics, and network activity. MirrorSim
does not transfer information to other networked systems unless specifically
requested by the user or the person installing or operating it. User-requested
network activity includes local AirPlay/mDNS traffic, GitHub update checks and
downloads, and external links the user chooses to open.

## User verification

Official downloads are published on
[GitHub Releases](https://github.com/Mahcks/MirrorSim/releases/latest). Each
release includes `checksums.txt`; users can compare the SHA-256 digest before
running an installer or portable archive. Once Authenticode signing is active,
this policy will be updated with the expected Windows signer identity and
verification instructions.
