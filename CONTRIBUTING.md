# Contributing to MirrorSim

MirrorSim is a Tauri 2 + Rust + React/TypeScript desktop app for Windows, with a bundled native AirPlay receiver runtime. This document covers local development setup, the AirPlay runtime workflow, and how release builds are produced. For what the app does and how to install a release build, see [README.md](README.md).

---

## Development

Install dependencies:

```powershell
bun install
```

Fetch the pinned, checksum-verified AirPlay runtime before launching the desktop app:

```powershell
bun run fetch:airplay-runtime
```

Run the frontend only:

```powershell
bun run dev
```

Run the Tauri desktop app:

```powershell
bun run tauri dev
```

Build the frontend:

```powershell
bun run build
```

Run Rust tests:

```powershell
cargo test --manifest-path src-tauri\Cargo.toml
```

Run the complete build, formatting, Clippy, and test suite for both Rust crates:

```powershell
bun run check
```

---

## AirPlay Runtime

MirrorSim expects the receiver runtime under:

```text
receivers/AirPlayServer/
```

Use the published runtime bundle:

```powershell
bun run fetch:airplay-runtime
```

Use a local sibling AirPlayServer build:

```powershell
bun run sync:airplay-runtime
```

`sync:airplay-runtime` looks for a sibling checkout at `..\AirPlayServer` and copies the built `MirrorSimAdapter.exe` plus required DLLs into MirrorSim.

Important: commands ending in `:fetch` download the runtime declared in `receivers/runtime-manifest.json`, which is pinned and checksum-verified. Use those when you want to validate the project's publishable state. Do not use `:fetch` when you are trying to test local changes in the sibling AirPlayServer fork — use `sync:airplay-runtime` instead so your local build is actually picked up.

---

## App Icon

The app icon is generated from `app-icon.png` (1024x1024), which is itself rendered by
`scripts/render-app-icon.py` (Python + Pillow/NumPy) rather than hand-exported from a design
tool, so the mark can be tweaked in code and regenerated exactly.

To adjust the icon:

```powershell
python scripts/render-app-icon.py
bun run tauri icon
```

The first command rewrites `app-icon.png`. The second regenerates every platform icon under
`src-tauri/icons/` (Windows `.ico`, macOS `.icns`, the Windows Store `Square*Logo.png` tiles, and
the unused iOS/Android sets Tauri scaffolds by default) from it.

---

## Release Builds

Release packaging is driven by `scripts/build-release.ps1`.

Local-runtime variants (uses whatever is currently under `receivers/AirPlayServer/`, typically from `sync:airplay-runtime`):

```powershell
bun run release:prep
bun run release:installer
bun run release:portable
bun run release:all
```

Published-runtime variants (fetches the pinned, checksum-verified runtime first — use these for anything that will actually be published):

```powershell
bun run release:prep:fetch
bun run release:installer:fetch
bun run release:portable:fetch
bun run release:all:fetch
```

Local-runtime packaging fails if a sibling AirPlayServer build is not available at `..\AirPlayServer`; it will not silently reuse an old runtime drop.

### Rust toolchain

Release packaging uses Rust `1.88.0-x86_64-pc-windows-msvc` through the release script and CI. Normal local development can use your installed stable Rust toolchain.

### Updater signing

Updater-enabled release builds require:

- `TAURI_SIGNING_PRIVATE_KEY`
- `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`, if your key has a password

### Runtime manifest and checksums

The GitHub release workflow (`.github/workflows/release.yml`) expects `receivers/runtime-manifest.json` to point at a downloadable AirPlay runtime zip with a matching SHA-256 checksum. The workflow also publishes `release/latest.json` for Tauri updater checks.

### Versioning and tags

The first public beta release uses MSI-safe numeric prerelease versions such as `v0.1.0-1`. Cut a release with a tag like:

```powershell
git tag v0.1.0-1
git push origin v0.1.0-1
```

Tags matching `v*` trigger the release workflow, which builds on `windows-latest` and uploads:

- NSIS installer (`.exe`) and its `.exe.sig`
- MSI installer (`.msi`) and its `.msi.sig`
- A portable `.zip`
- `release/latest.json` (Tauri updater manifest)
- `release/checksums.txt`

Before publishing, the workflow verifies that the Git tag matches the versions in `package.json`, `src-tauri/Cargo.toml`, and `src-tauri/tauri.conf.json`. It uses `scripts/validate-release-version.ps1` for this check. Every uploaded installer, signature, portable archive, and updater manifest must be represented in `checksums.txt`.

---

## Before you open a PR

- Run `bun run check` — it runs the build, formatting, lint (Clippy), tests, and audit for both the frontend and the Rust crates.
- The CI workflow (`.github/workflows/ci.yml`) runs on pull requests and on pushes to `main`; make sure your branch passes it.
- If your change affects versioning or release packaging, `scripts/validate-release-version.ps1` is what the release workflow uses to confirm the Git tag matches `package.json`, `src-tauri/Cargo.toml`, and `src-tauri/tauri.conf.json` — check it locally if you're touching version numbers.
