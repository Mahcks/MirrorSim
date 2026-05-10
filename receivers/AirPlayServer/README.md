# Bundled AirPlay Runtime

This folder holds the native AirPlay receiver runtime that MirrorSim packages into its Windows releases.

Expected executable:

```text
receivers/AirPlayServer/MirrorSimAdapter.exe
```

Expected working directory:

```text
receivers/AirPlayServer/
```

## What belongs here

Before building installer or portable releases, place the adapter and any required runtime files here:

- `MirrorSimAdapter.exe`
- required DLLs
- required config or runtime assets

This folder is bundled into release artifacts through `src-tauri/tauri.conf.json`, so shipped builds can run without asking users to install a separate AirPlay receiver package.

## Sync From a Local AirPlayServer Build

If you have the sibling AirPlayServer repository checked out locally, MirrorSim can copy the current runtime into this folder for you:

```powershell
bun run fetch:airplay-runtime
bun run sync:airplay-runtime
```

`bun run fetch:airplay-runtime` downloads the versioned runtime bundle declared in `receivers/runtime-manifest.json`.
`bun run sync:airplay-runtime` copies the runtime from a local sibling AirPlayServer checkout.

Default source search order:

1. `..\AirPlayServer\AirPlayServer\bin\x64`
2. `..\AirPlayServer\x64\Release`
3. `..\AirPlayServer\x64\Debug`

Optional flags:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/sync-airplay-runtime.ps1 -IncludeDebugSymbols
powershell -ExecutionPolicy Bypass -File scripts/sync-airplay-runtime.ps1 -SourceDir C:\path\to\custom\output
```

If you downloaded a public MirrorSim release, you can ignore this folder.
