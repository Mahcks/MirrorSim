# Receiver Runtime Notes

This folder contains receiver-related pieces used by MirrorSim during development and packaging.

For most end users, this folder does not matter. Public releases already bundle the runtime they need.

## What is here

- `mirror-receiver/`: development-side receiver integration work
- `AirPlayServer/`: the packaged native receiver runtime used by MirrorSim releases

## Public Release Behavior

MirrorSim expects the bundled native receiver runtime at:

```text
receivers/AirPlayServer/MirrorSimAdapter.exe
```

That folder is included in both installer and portable outputs. End users should not need to install a separate AirPlay receiver package as long as the required runtime files are present before packaging.

## Maintainer Workflow

Before building a release, choose exactly one runtime source:

```powershell
bun run fetch:airplay-runtime
```

Or, when intentionally testing a sibling AirPlayServer build:

```powershell
bun run sync:airplay-runtime
```

- `fetch:airplay-runtime` downloads the versioned runtime bundle declared in `receivers/runtime-manifest.json`
- `sync:airplay-runtime` copies files from a local sibling AirPlayServer build if you have one

Then build the app with one of the release commands from the main project README.

## Developer Notes

The development-side receiver pieces here are still implementation detail. MirrorSim's shipping experience relies on the bundled native adapter runtime and the Tauri app's packaged resources rather than a separately installed external receiver.

