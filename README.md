# MirrorSim

MirrorSim is a Tauri desktop shell for an iPhone-to-Windows mirroring app.

The repository now contains the first working shell layer at the repo root:

- React + Vite frontend
- Tauri desktop wrapper
- First-pass simulator-style device stage
- Mock session controls for orientation, quality profile, and shell tone
- MediaSource preview surface fed by local fragmented MP4 fixtures
- Mock receiver IPC contract for runtime status and preview transport descriptors
- First-pass Rust remux boundary for H.264 access-unit and fMP4 segment descriptors
- Direct receiver sidecar protocol spec for the future native ingest process
- Runnable receiver sidecar skeleton under `receivers/mirror-receiver`
- AirPlayServer `MirrorSimAdapter` headless target builds and is now the preferred direct sidecar path

## Run

Install dependencies at the repo root:

```bash
bun install
```

Start the frontend shell:

```bash
bun run dev
```

Build the frontend shell:

```bash
bun run build
```

Run the Tauri app:

```bash
bun run tauri dev
```

## Current Scope

The current shell is the Milestone 0 surface from the project outline:

- a proper desktop app root
- a framed device stage
- session and readiness panels
- a MediaSource playback slice driven by fixture fragments

It does not include real mirroring yet. The next technical milestone is feeding the AirPlayServer adapter's real access-unit output into the remux boundary and replacing the fixture transport.

## Next Steps

1. Feed the AirPlayServer adapter's real H.264 access units into the remux boundary and emit preview fragments.
2. Replace the fixture transport in the current Tauri receiver contract.
3. Add stream health diagnostics, discontinuity handling, and reconnect policy.
4. Add audio-path integration once video ingest is stable.