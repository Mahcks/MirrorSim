# MirrorSim

[![Latest release](https://img.shields.io/github/v/release/Mahcks/MirrorSim?include_prereleases&sort=semver&label=release&style=flat-square)](https://github.com/Mahcks/MirrorSim/releases/latest)
[![CI](https://img.shields.io/github/actions/workflow/status/Mahcks/MirrorSim/ci.yml?branch=main&label=CI&style=flat-square)](https://github.com/Mahcks/MirrorSim/actions)
[![License](https://img.shields.io/github/license/Mahcks/MirrorSim?style=flat-square)](LICENSE)
[![Downloads](https://img.shields.io/github/downloads/Mahcks/MirrorSim/total?style=flat-square)](https://github.com/Mahcks/MirrorSim/releases/latest)
![Platform](https://img.shields.io/badge/platform-Windows%20x64-0078D6?style=flat-square&logo=windows&logoColor=white)

MirrorSim mirrors an iPhone over AirPlay into a clean, presentation-ready device-frame window on Windows — no cable, no clutter, no generic receiver UI in your screenshots. Point your iPhone at it from Control Center and you get a focused, floating device frame ready for demos, QA, screen recordings, and walkthroughs.

<!-- TODO: replace with a real demo GIF (~10-15s) showing: launch MirrorSim -> iPhone Control Center -> Screen Mirroring -> live mirrored preview in Minimal mode -> a quick screenshot/recording capture. Suggested size: under 8MB, ~800px wide. Tools: ScreenToGif (free, Windows) or ffmpeg (mp4 -> optimized gif via palette generation). Save as docs/images/demo.gif and reference it here. -->

<p align="center">
  <img src="docs/images/map-minimal-vertical.png" alt="MirrorSim Minimal mode mirroring Apple Maps in portrait orientation" width="300">
</p>

<p align="center">
  <a href="https://github.com/Mahcks/MirrorSim/releases/latest"><img src="https://img.shields.io/badge/Download-Installer-0078D6?style=for-the-badge&logo=windows&logoColor=white" alt="Download Installer"></a>
  <a href="https://github.com/Mahcks/MirrorSim/releases/latest"><img src="https://img.shields.io/badge/Download-Portable%20(.zip)-0078D6?style=for-the-badge&logo=windows&logoColor=white" alt="Download Portable zip"></a>
</p>

> MirrorSim includes a bundled AirPlay receiver runtime built from a fork of [AirPlayServer by xenos1337](https://github.com/xenos1337/AirPlayServer). MirrorSim provides the desktop app, UI, capture tools, diagnostics, and release packaging around that receiver layer.

<details>
  <summary>Screenshots</summary>

  <p align="center">
    <img src="docs/images/map-console-preview.png" alt="MirrorSim Console mode with live iPhone preview and controls" width="720">
  </p>

  <p align="center">
    <img src="docs/images/map-minimal-landscape.png" alt="MirrorSim Minimal mode mirroring Apple Maps in landscape orientation" width="560">
  </p>
</details>

---

## Why MirrorSim

Screen mirroring an iPhone on Windows usually means QuickTime on a Mac you don't have, a cable, or a generic receiver window full of chrome you have to crop out later. MirrorSim is built specifically for people who need a clean, reliable, real-hardware mirror of an iPhone on a Windows machine:

- **QA and bug repro on real hardware** — reproduce and capture issues on an actual iPhone, not a simulator, with diagnostics (buffer, rate, dropped/queued frames, last error) visible right in Console mode.
- **Product and marketing screenshots** — a clean device frame with no receiver chrome, ready to drop straight into a deck, store listing, or blog post.
- **App walkthroughs and tutorials** — record `.webm` walkthroughs of your app running on real iOS, not an emulator skin.
- **Live client and stakeholder demos** — Minimal mode gives you a floating, presentation-ready overlay you can screen-share without exposing the rest of your desktop.
- **Conference and presentation mirroring** — mirror to the room without a Lightning-to-HDMI dongle or a cable snaking to the podium.
- **Remote support and pairing sessions** — see exactly what a teammate or user sees on their device in real time, over Wi-Fi.
- **Content creation** — capture iPhone app footage for videos, tutorials, or social content directly to disk.

---

## Highlights

- Live iPhone screen mirroring over Wi-Fi
- Minimal floating device-frame mode for demos and recordings
- Console mode with connection state, diagnostics, capture history, and controls
- Portrait and landscape framing with automatic orientation updates
- Screenshots to disk and/or clipboard
- Local `.webm` screen recordings from the preview surface
- Adjustable preview quality and live-edge catch-up presets
- Trusted-device preferences and receiver access controls
- Bonjour readiness checks and helpful troubleshooting actions

---

## Requirements

- Windows 10 or later, x64
- [Bonjour for Windows](https://support.apple.com/kb/DL999)
- iPhone and PC on the same Wi-Fi network
- Windows Firewall allowing MirrorSim on the network you are using

MirrorSim bundles its AirPlay receiver runtime in release builds. You do not need to install a separate receiver package.

---

## Install

### Unsigned beta builds

MirrorSim is currently shipping as an unsigned early beta while the project is still getting its first public releases out. Windows SmartScreen may warn on first launch.

To run the official GitHub release build:

1. Click **More info** on the SmartScreen warning.
2. Click **Run anyway**.

Only download MirrorSim from the official [GitHub Releases](https://github.com/Mahcks/MirrorSim/releases/latest) page. Release assets include SHA-256 checksums (`checksums.txt`) so you can verify the installer or portable zip before running it.

MirrorSim ships in two formats:

- **Installer**: best for most users. Installs MirrorSim like a normal desktop app.
- **Portable zip**: extract and run without a full install.

### Installer

1. Download the latest MirrorSim installer from [GitHub Releases](https://github.com/Mahcks/MirrorSim/releases/latest).
2. Run the installer.
3. Install Bonjour for Windows if your iPhone cannot discover MirrorSim.
4. Launch MirrorSim from Start or the desktop shortcut.

### Portable

1. Download the latest portable zip from [GitHub Releases](https://github.com/Mahcks/MirrorSim/releases/latest).
2. Extract it to a folder you control.
3. Run `MirrorSim.exe`.
4. Install Bonjour for Windows if your iPhone cannot discover MirrorSim.

---

## Use MirrorSim

1. Launch MirrorSim.
2. Click **Start**.
3. On your iPhone, open Control Center.
4. Tap **Screen Mirroring**.
5. Choose the receiver name shown in MirrorSim, usually `MirrorSim`.
6. Approve the pairing/trust prompt if MirrorSim asks for it.

The live iPhone preview appears inside the device frame. Use Minimal mode when you want the clean floating overlay, or Console mode when you want diagnostics, settings, and capture history visible.

---

## Modes

**Minimal mode** is the showcase view: just the device frame, a compact title bar, and quick controls for capture, recording, rotation, preferences, and switching back to Console.

**Console mode** is the control room: connection status, Bonjour state, diagnostics, capture history, recording controls, trusted devices, and troubleshooting tools.

---

## Captures

By default, captures are saved under:

```text
Pictures/MirrorSim/
```

Default filenames:

- Screenshots: `mirrorsim_screenshot_YYYYMMDD_HHMMSS.png`
- Recordings: `mirrorsim_recording_YYYYMMDD_HHMMSS.webm`

Preferences let you choose whether screenshots save to disk, copy to clipboard, or both. You can also change the screenshot and recording folders.

---

## Keyboard Shortcuts

| Shortcut | Action |
| --- | --- |
| `Ctrl+S` | Take screenshot |
| `Ctrl+R` | Toggle recording |
| `Ctrl+F` or `F` | Toggle fullscreen |
| `Ctrl+M` | Toggle Console/Minimal mode |
| Double-click the device | Toggle fullscreen |
| `F1` | Toggle diagnostics, switching to Console mode if needed |
| `H` | Hide or show the Minimal mode toolbar |
| `Esc` | Close Preferences or the context menu |

---

## Preview Presets

Preview presets tune the desktop playback surface. They do not change the iPhone's AirPlay stream quality directly; they adjust scaling and how aggressively MirrorSim catches up to the live edge after small stalls or sleep/wake hiccups.

| Preset | Best for | Behavior |
| --- | --- | --- |
| Good quality | Demos and review | Smooth scaling with a slightly steadier preview |
| Balanced | Everyday use | A practical balance between clarity and latency |
| Fast speed | Lowest latency | More aggressive live-edge catch-up and pixelated scaling |

---

## Current Limitations

MirrorSim is focused on screen mirroring.

- **System audio capture/playback is not currently included. It's actively being worked on**
- DRM-protected video playback is not supported.
- AirPlay discovery depends on Bonjour and local network/firewall conditions.
- Sleep/wake and reconnect behavior depends partly on how iOS resumes the AirPlay sender session.

---

## Troubleshooting

### iPhone does not see MirrorSim

- Install Bonjour for Windows.
- Make sure the Bonjour Service is running.
- Put the iPhone and PC on the same Wi-Fi network.
- Allow MirrorSim through Windows Firewall on private networks.
- Avoid VPNs, proxies, or VM/NAT networking while testing discovery.

MirrorSim can show Bonjour status in-app and can open the Bonjour download, Windows Services, and Windows Firewall pages for you.

### Session connects but stays blank or gets delayed

- Open Console mode and expand diagnostics.
- Watch `Buffer`, `Rate`, `Dropped`, `Queued`, `Init`, `Appended`, and `Last error`.
- Try the **Fast speed** preset for lower latency.
- Disconnect and reconnect the iPhone from Control Center if iOS resumes from sleep in a bad state.
- Restart MirrorSim if the native receiver runtime has been left running from an older dev build.

### Screenshots or recording are not available

The preview must be live and decodable before capture works. If MirrorSim says the live preview is not ready, wait for the iPhone frame to appear or reconnect the session.

---

## Tech Stack

Tauri 2, Rust, React, TypeScript, Tailwind CSS, and a bundled native AirPlay receiver runtime.

---

## Contributing

Want to build MirrorSim from source, work on a fix, or cut a release? See [CONTRIBUTING.md](CONTRIBUTING.md) for local dev setup, the AirPlay runtime workflow, and release/build instructions.

---

## Credits

MirrorSim depends on work from the AirPlay reverse-engineering and open-source desktop media communities.

- [AirPlayServer](https://github.com/xenos1337/AirPlayServer) by xenos1337
- [airplay2-win](https://github.com/fingergit/airplay2-win) by fingergit
- Bonjour, FFmpeg, SDL2, and related libraries used by the bundled receiver runtime

MirrorSim itself is licensed under MIT. The bundled AirPlay receiver runtime includes separate third-party license terms in `LICENSES/AirPlayServer-LICENSE`.

Apple, AirPlay, and iPhone are trademarks of Apple Inc. MirrorSim is an independent project and is not affiliated with or endorsed by Apple Inc.
