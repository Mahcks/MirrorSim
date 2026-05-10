# Receiver Sidecars

`mirror-receiver` is the first executable sidecar skeleton for MirrorSim's direct receiver protocol.

Current scope:

- boots over stdio JSON lines
- supports `--backend stub` and `--backend airplayserver`
- emits `receiver_ready`
- accepts `start_session`, `stop_session`, `request_keyframe`, and `shutdown`
- emits `session_started`, `stream_discontinuity`, and `receiver_error`
- can launch an external native receiver process for the AirPlayServer adapter mode

This is not a working AirPlay receiver yet. It now owns the real process boundary for an AirPlayServer-style native receiver wrapper, but it does not yet translate native receiver media output into `video_access_unit` events.

## Run

```powershell
Push-Location receivers/mirror-receiver
cargo run
Pop-Location
```

Run the AirPlayServer adapter mode:

```powershell
Push-Location receivers/mirror-receiver
cargo run -- --backend airplayserver --airplayserver-exe C:\path\to\AirPlayServer.exe
Pop-Location
```

## Near-Term Direction

The likely production path is still a native receiver core such as AirPlayServer or another native implementation behind this sidecar contract. The next integration step is mapping the native receiver output to real `video_access_unit` messages and feeding those into the existing Rust remux boundary.

