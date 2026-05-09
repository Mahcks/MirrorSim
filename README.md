# MirrorSim

MirrorSim is a Tauri desktop shell for an iPhone-to-Windows mirroring app.

The repository now contains the first working shell layer at the repo root:

- React + Vite frontend
- Tauri desktop wrapper
- First-pass simulator-style device stage
- Mock session controls for orientation, quality profile, and shell tone

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
- an interaction model we can hang the media pipeline on next

It does not include real mirroring yet. The next technical milestone is proving MediaSource playback with known-good fragmented MP4 inside the shell.

## Next Steps

1. Add a mock MediaSource player fed by fixture fragments.
2. Define the IPC contract between the Tauri shell and a future receiver sidecar.
3. Build the Rust remux crate boundary for H.264 access units to fMP4 output.
4. Integrate a native receiver sidecar after playback and transport are stable.