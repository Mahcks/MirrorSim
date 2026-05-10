# MirrorSim

**Live iPhone screen mirroring for Windows — beautiful, low-latency, and built for developers.**

MirrorSim is a Windows desktop app for receiving and presenting a real iPhone screen mirror through a native AirPlay receiver pipeline. Connect your iPhone, see it live on your desktop inside a clean device frame, capture screenshots, and record sessions — all with minimal latency and no cables required.

> MirrorSim is a sidecar application built on top of [AirPlayServer by xenos1337](https://github.com/xenos1337/AirPlayServer). Without that project — and the broader AirPlay reverse engineering community it builds on — MirrorSim would not exist. All credit for the underlying receiver pipeline belongs entirely to its authors.

---

## What it does

- **Live screen mirroring** from iPhone over Wi-Fi via AirPlay
- **Clean device frame** — the mirrored screen is the hero, not a cluttered dashboard
- **1:1 screenshots** — pixel-perfect PNG captures of the device screen only
- **Session recording** — captures the live H.264 stream directly, not a screen grab
- **Two UI modes** — a full Console view for monitoring and a minimal Floating view for presentations
- **Quality presets** — 30fps Lanczos, 60fps bilinear, or 60fps nearest-neighbor for lowest latency
- **Diagnostics panel** — connection log, frame timing, bitrate history, for when things go wrong

---

## Installation

1. Download the latest release from the [Releases page](../../releases)
2. Extract the zip to a folder of your choice
3. Install [Bonjour for Windows](https://support.apple.com/kb/DL999) if you don't have it — required for device discovery. Installing iTunes also installs Bonjour.
4. Run `MirrorSim.exe` — the app will warn you at startup if Bonjour is missing or not running

**Requirements:**
- Windows 10 or later (x64)
- Apple Bonjour for Windows
- iPhone on the same Wi-Fi network as your PC

---

## Usage

1. Launch MirrorSim
2. On your iPhone, open Control Center and tap **Screen Mirroring**
3. Select your Windows PC from the list
4. Your iPhone screen appears live in MirrorSim

---

## Keyboard shortcuts

| Key | Action |
|-----|--------|
| `Cmd+S` | Take screenshot |
| `Cmd+R` | Toggle recording |
| `Cmd+F` | Toggle fullscreen |
| `Cmd+M` | Toggle UI mode (Console ↔ Minimal) |
| `F` / Double-click | Toggle fullscreen |
| `F1` | Toggle diagnostics panel |
| `H` | Toggle overlay UI |

---

## UI modes

**Console view** — the full dashboard. Device frame centered, controls below, session info and capture history in the right panel, diagnostics collapsed at the bottom.

**Minimal floating view** — just the device. A slim titlebar, the iPhone frame, and nothing else. Right-click the device for screenshot, recording, zoom, and copy-to-clipboard options. Perfect for screen recording or presenting your app.

Toggle between modes with `Cmd+M` or via the right-click context menu in Minimal mode.

---

## Captures

Screenshots and recordings are saved to `Documents/MirrorSim/` by default.

- Screenshots: `mirrorsim_screenshot_YYYYMMDD_HHMMSS.png` — pixel-perfect PNG of the device screen only, no frame chrome
- Recordings: `mirrorsim_recording_YYYYMMDD_HHMMSS.mp4` — captured directly from the H.264 pipeline

The output folder is configurable in Settings.

---

## Quality presets

| Preset | FPS | Scaling | Best for |
|--------|-----|---------|----------|
| Good quality | 30 | Lanczos | Crisp image, slower devices |
| Balanced | 60 | Bilinear | Default — smooth and sharp |
| Fast speed | 60 | Nearest-neighbor | Lowest possible latency |

---

## Troubleshooting

**Device not appearing on iPhone**
- Make sure Bonjour for Windows is installed and the Bonjour Service is running (`services.msc`)
- Both devices must be on the same Wi-Fi network and subnet
- Check Windows Firewall — allow MirrorSim through for Private networks

**Connects but no video**
- If running Windows in a VM, use bridged networking, not NAT
- Verify no VPN or proxy is interfering with the connection

---

## Built on the shoulders of giants

MirrorSim would not exist without the following people and projects. They did the hard work.

### [AirPlayServer](https://github.com/xenos1337/AirPlayServer) — xenos1337

The entire AirPlay receiver pipeline powering MirrorSim — mDNS discovery, AirPlay 2 protocol handling, H.264 decode via FFmpeg, YUV→RGB conversion, GPU texture upload, SDL2 rendering, and audio playback — is built on AirPlayServer. xenos1337 took an existing foundation and rebuilt it into a high-performance, low-latency receiver that actually works on modern Windows. MirrorSim is a UI shell around this engine. The engine is theirs.

### [fingergit / airplay2-win](https://github.com/fingergit/airplay2-win)

The original Windows AirPlay 2 receiver that AirPlayServer was forked from and substantially extended. The foundational protocol work lives here.

### Libraries and dependencies

- **SDL2** — cross-platform windowing and rendering
- **FFmpeg** — H.264 decode pipeline
- **Dear ImGui** — overlay UI
- **Bonjour / mDNS** — device discovery

---

## License

MirrorSim inherits the license terms of its dependencies. See [AirPlayServer](https://github.com/xenos1337/AirPlayServer) and its constituent libraries for full license details.

Apple, AirPlay, and iPhone are trademarks of Apple Inc. MirrorSim is an independent project and is not affiliated with, endorsed by, or sponsored by Apple Inc.

---

## Contributing

Issues, feature requests, and pull requests are welcome. For anything related to the underlying AirPlay receiver behavior, please consider also opening an issue upstream at [xenos1337/AirPlayServer](https://github.com/xenos1337/AirPlayServer).