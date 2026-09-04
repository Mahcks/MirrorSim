# Security Policy

## Supported versions

Security fixes are made against the latest stable MirrorSim release and the
current `main` branch. Older releases may be asked to update before a report is
investigated.

| Version | Supported |
| --- | --- |
| Latest stable release | Yes |
| `main` | Best effort |
| Older releases | No |

## Reporting a vulnerability

Please do not disclose a suspected vulnerability in a public issue, discussion,
pull request, or diagnostic attachment.

Use GitHub's private
[Report a vulnerability](https://github.com/Mahcks/MirrorSim/security/advisories/new)
flow. If that flow is unavailable, open a public issue that asks the maintainer
for a private contact channel without including vulnerability details.

Include, when applicable:

- The affected MirrorSim version and installation method
- Whether the issue affects the desktop app, updater, bundled receiver, pairing,
  discovery, capture, or diagnostics
- Windows and iOS versions relevant to the report
- Reproduction steps or a minimal proof of concept
- The security impact and any known mitigations
- Sanitized logs that do not contain credentials, pairing material, private
  network information, or personal content

MirrorSim diagnostics redact stable device and session identifiers by default,
but reporters should still review every file before sharing it.

Reports are handled on a best-effort basis. The maintainer will aim to
acknowledge a complete report within seven days, investigate it privately, and
coordinate disclosure after a fix or mitigation is available.

## Scope

This policy covers MirrorSim and the receiver runtime bundled with official
MirrorSim releases. A vulnerability that affects an upstream dependency may be
shared with the relevant upstream maintainer as part of coordinating a fix.

