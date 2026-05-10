# AirPlayServer Drop-In Location

Place the native AirPlay receiver binary here when you are ready to test the adapter mode.

Expected default path from the current sidecar launch spec:

```text
receivers/AirPlayServer/AirPlayServer.exe
```

Current status:

- `mirror-receiver` can launch this binary in `--backend airplayserver` mode
- the sidecar still needs output mapping from the native receiver into `video_access_unit` events
- no vendored AirPlayServer source or binary is committed in this repository yet
