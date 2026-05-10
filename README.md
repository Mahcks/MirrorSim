# MirrorSim

MirrorSim is a Windows app for live iPhone screen mirroring over AirPlay. It gives you a polished device frame, fast low-latency preview, screenshots, recordings, and a presentation-friendly floating mode without needing a cable.

It is intended for demos, product previews, app capture, QA, and content creation on Windows.

> MirrorSim uses a bundled AirPlay receiver runtime built on top of [AirPlayServer by xenos1337](https://github.com/xenos1337/AirPlayServer). MirrorSim provides the desktop shell, controls, capture tools, and packaging around that receiver layer.

---

## Highlights

- Live iPhone mirroring over Wi-Fi
- Minimal and Console viewing modes
- Clean Apple-style device presentation
- Pixel-perfect screenshots
- Local recording to `.webm`
- Adjustable quality and scaling presets
- Built-in diagnostics when sessions misbehave

---

## Install MirrorSim

MirrorSim supports two release formats:

- **Installer**: best for most users
- **Portable zip**: extract and run anywhere you want

### Requirements

- Windows 10 or later (x64)
- [Bonjour for Windows](https://support.apple.com/kb/DL999)
- iPhone and PC on the same Wi-Fi network

### Installer

1. Download the latest installer from the release page.
2. Run the installer.
3. Install Bonjour if prompted or if your device does not appear.
4. Launch MirrorSim from Start or the desktop shortcut.

### Portable

1. Download the latest portable zip.
2. Extract it to any folder.
3. Install Bonjour if needed.
4. Run `MirrorSim.exe`.

MirrorSim bundles the receiver runtime inside both installer and portable releases. End users do not need to install a separate AirPlay receiver package.

---

## Use MirrorSim

1. Launch MirrorSim.
2. On your iPhone, open Control Center.
3. Tap **Screen Mirroring**.
4. Select your Windows PC.
5. MirrorSim will open the live session inside its device frame.

---

## Keyboard Shortcuts

| Key | Action |
|-----|--------|
| `Ctrl+S` | Take screenshot |
| `Ctrl+R` | Toggle recording |
| `Ctrl+F` | Toggle fullscreen |
| `Ctrl+M` | Toggle UI mode |
| `F` / Double-click | Toggle fullscreen |
| `F1` | Toggle diagnostics |
| `H` | Toggle overlay UI |

---

## Modes

**Console mode** gives you controls, connection state, capture history, and diagnostics.

**Minimal mode** strips the app down to the framed device and a lightweight header so it works well during demos, recording, or presentations.

---

## Captures

By default, captures are saved under `Documents/MirrorSim/`.

- Screenshots: `mirrorsim_screenshot_YYYYMMDD_HHMMSS.png`
- Recordings: `mirrorsim_recording_YYYYMMDD_HHMMSS.webm`

You can change the save location in the app preferences.

---

## Quality Presets

| Preset | FPS | Scaling | Best for |
|--------|-----|---------|----------|
| Good quality | 30 | Lanczos | Sharper image on slower systems |
| Balanced | 60 | Bilinear | Default everyday mode |
| Fast speed | 60 | Nearest-neighbor | Lowest latency |

---

## Troubleshooting

### iPhone does not see your PC

- Make sure Bonjour is installed and the Bonjour Service is running.
- Make sure both devices are on the same network.
- Allow MirrorSim through Windows Firewall on private networks.

MirrorSim will warn you in the session panel if Bonjour is missing or if the Bonjour Service is stopped, and it can open the installer link or Windows Services directly.

### Session connects but stays blank

- Disable VPNs or proxies temporarily.
- Avoid NAT networking if you are using a VM.
- Open diagnostics in MirrorSim to inspect session state and runtime issues.

---

## For Maintainers

If you are building releases yourself:

```powershell
bun run fetch:airplay-runtime
bun run sync:airplay-runtime
bun run release:prep
bun run release:prep:fetch
bun run release:installer
bun run release:installer:fetch
bun run release:portable
bun run release:portable:fetch
bun run release:all
bun run release:all:fetch
```

Use `bun run fetch:airplay-runtime` when you want MirrorSim to download the versioned runtime bundle declared in `receivers/runtime-manifest.json`.
Use `bun run sync:airplay-runtime` when you have a local sibling AirPlayServer build and want to copy it in directly.
Use the `*:fetch` release commands when you want local release validation to use the published runtime bundle instead of your sibling AirPlayServer checkout.

- `release:prep` syncs the bundled receiver runtime and builds the frontend
- `release:installer` builds installer artifacts through Tauri
- `release:portable` builds `release/portable/MirrorSim-portable-v<version>.zip`
- `release:all` builds both installer and portable outputs

This repo is pinned to Rust `1.88.0` for release builds.

For GitHub Releases, `.github/workflows/release.yml` expects `receivers/runtime-manifest.json` to point at a real downloadable runtime zip and checksum.

---

## Credits

MirrorSim depends on the work of the AirPlay reverse-engineering community.

- [AirPlayServer](https://github.com/xenos1337/AirPlayServer) by xenos1337
- [airplay2-win](https://github.com/fingergit/airplay2-win) by fingergit
- Bonjour, FFmpeg, SDL2, and related upstream libraries used by the bundled receiver runtime

Apple, AirPlay, and iPhone are trademarks of Apple Inc. MirrorSim is an independent project and is not affiliated with or endorsed by Apple Inc.