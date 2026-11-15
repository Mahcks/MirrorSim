# Reported issue fixes

## Receiver startup (#5)

The companion `../AirPlayServer` changes add an opt-in
`dynamic-listening-ports` capability to protocol 0.8.0. MirrorSim sets
`MIRRORSIM_DYNAMIC_PORTS=1`. When binding a preferred TCP port fails with
Windows access-denied or address-in-use, the native receiver binds port zero
and keeps the resulting socket open. This avoids probing and releasing a
port before use. Other socket errors still fail startup.

The adapter emits `receiver_listening` with `session_id`, `raop_port`, and
`airplay_port` after startup succeeds. MirrorSim waits for these actual ports
before advertising, validates the session correlation and port values, and
clears the advertisement on stop. Discovery refresh retains the bound ports;
a receiver process restart requires a new acknowledgement. Older runtimes
retain their fixed-port behavior.

Native regression test (Windows, after building the sibling solution):

```powershell
python ../AirPlayServer/tests/test_listening_ports.py ../AirPlayServer/AirPlayServer/bin/x64/MirrorSimAdapter.exe
```

The test exclusively binds 5001, 7001, and 7100, verifies legacy startup fails,
then verifies opt-in startup succeeds on different ports, accepts TCP
connections, and survives stop/start. It uses an isolated temporary pairing
identity. Close any locally running receiver before executing this test.

Publish the companion runtime and update `receivers/runtime-manifest.json`
with its real release URL and checksum before shipping this fix. The existing
v0.5.0 release does not contain the native change; fetching that pinned runtime
will restore the old behavior. Use the rebuilt local runtime for validation.

## Island alignment (#10)

Live preview and framed captures no longer draw a synthetic Dynamic Island
over the source. The source pixels determine whether a cutout is visible.
The decorative device border remains. Physical iPhone validation is still
needed for portrait, both landscape directions, and active island content.

## Dependencies and CI

Vite is updated to 8.3.8 and transitive `source-map-js` is constrained to the
patched 1.2.2 series or newer compatible versions. Both CI and release jobs
exit immediately when either Rust advisory scan fails. Release validation also
checks the version-validation process exit code before running project checks.
