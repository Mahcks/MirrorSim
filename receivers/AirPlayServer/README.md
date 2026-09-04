# Bundled AirPlay Runtime

This folder holds the native AirPlay receiver runtime that MirrorSim packages into its Windows releases.

The bundled runtime's upstream license text is stored at `LICENSES/AirPlayServer-LICENSE` in the repository root and is packaged into installer and portable release builds.

Expected executable:

```text
receivers/AirPlayServer/MirrorSimAdapter.exe
```

Expected working directory:

```text
receivers/AirPlayServer/
```

## Exact runtime inventory

Release validation requires exactly these native files. Published runtime
archives may additionally carry `LICENSE`, `README.md`,
`THIRD_PARTY_NOTICES.md`, and license subdirectories:

- `MirrorSimAdapter.exe`
- `airplay2dll.dll`
- `avcodec-62.dll`
- `avutil-60.dll`
- `swscale-9.dll`

Every native file must be an x64 Windows PE image, and the adapter must complete the protocol `0.8.0` startup/shutdown smoke test. This folder is bundled into release artifacts through `src-tauri/tauri.conf.json`, so shipped builds can run without asking users to install a separate AirPlay receiver package or Bonjour.

## Sync From a Local AirPlayServer Build

Choose the pinned published runtime:

```powershell
bun run fetch:airplay-runtime
```

Or, if you have the sibling AirPlayServer repository checked out locally, copy that build instead:

```powershell
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
