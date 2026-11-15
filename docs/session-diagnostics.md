# Investigating long AirPlay sessions

## Short tests without a phone

Run these before asking someone to reproduce a long session:

```powershell
bun test tests/previewRecovery.test.ts
cargo test --locked --manifest-path src-tauri/Cargo.toml accelerated_long_session
python scripts/probe-airplay-control.py --cycles 200
```

The Python probe is Windows-only, starts its own bundled receiver, disables its
Bonjour advertising, connects only through localhost, and refuses to run if
receiver ports 5001 or 7001 are occupied. Close MirrorSim's listener first. It
tests normal control requests, TCP resets, resets during partial requests, and
up to 20 receiver stop/start cycles. It samples private memory and handle counts,
drains both output pipes, and stops only the receiver it launched. `--runtime`
can point at a different runtime directory for a before/after comparison.

### Investigation results, September 20, 2026

- **Reproduced and fixed a preview recovery failure.** After the backend signaled
  lost continuity, the frontend immediately closed its decoder and stopped
  polling. It never consumed a later recovery IDR even though the backend could
  deliver it. An expired bootstrap cache had the same problem. Both regression
  tests failed before the fix in milliseconds. The frontend now preserves the
  displayed frame, skips delta frames, and polls for a new IDR for up to 30
  seconds of visible-window recovery time. Repeated loss signals do not reset
  the deadline. Cancellation stops polling. A timeout still reports an error.
  Five tests cover these paths using simulated IPC and decoder callbacks; they
  exercise real frontend control flow, not hardware decoding.
- **Accelerated backend timeline passed.** 270,000 frames (75 minutes at 60 fps)
  took about 1.05 seconds in the Rust test. Decode timestamps crossed the 32-bit
  microsecond boundary without wrapping; consumed queues remained empty and the
  configured GOP cache stayed bounded. This tests parsing, queueing, and timestamp
  bookkeeping, not native receiver throughput or graphics-driver behavior.
- **Bundled control-channel probe passed.** 200 clean-close, 200 reset, and 200
  partial-request-reset cycles, followed by 20 stop/start cycles, completed in
  29.734 seconds with clean shutdown. Private bytes stayed at 3,874,816 and handles
  at 97 across the control-connection phases. After stop/start cycling they were
  4,026,368 and 98; this small change alone neither proves nor excludes a leak.
  The manifest declares runtime v0.5.0. The probe does not authenticate an iPhone,
  send encrypted media, or exercise the separate mirror-data TCP connection.

The native source review also found that `httpd.c` passes negative `recv()`
results into `http_request_add_data` instead of explicitly closing the failed
connection. The probe logged 400 parser errors during its reset phases, but the
receiver remained responsive. This is a defensive-fix candidate, **not a proven
cause of the reported long-session drop**. The sibling native checkout and
bundled runtime have not been modified by this investigation. Next native
targets are an isolated mirror-data transport harness for partial packets,
reconnects, pause/resume, and concurrent teardown, followed by blocked-consumer
tests for the adapter's stdout queue. These can also be exercised without an
hour-long phone session.

## Capturing a naturally occurring incident

Use a build with the flight recorder enabled and mirror normally. There is no
need to leave Console mode open or record the screen.

1. When latency becomes noticeable, open Preferences > Support and choose
   **Mark problem now**. Receiver interruptions and some preview stalls also
   create incidents automatically.
2. Keep the app running for about 30 seconds to retain the aftermath. If the app
   is still responsive, export before restarting it.
3. Choose **Export** in the same section. Note what the phone was doing, whether
   audio continued, and whether the receiver was still visible in Screen
   Mirroring. Review the JSON before sharing it.

The export's `flightRecorder.currentRun` contains the most recent 3,600 samples
(about two hours at the nominal two-second cadence) and up to four incidents.
Each incident pins up to two minutes of preceding samples, the trigger state,
and up to 30 seconds afterward, plus recent receiver logs before and afterward.
Repeated identical incident reasons within 60 seconds are coalesced. The oldest
incident is evicted when a fifth is retained. Samples and incident counts are
bounded even during very long sessions.

Sampling runs in Rust independently of frontend reports. Each sample includes
monotonic elapsed time, connection/configuration generations, received media
counts and ages, backend queue counters, and the latest frontend report with
its age and whether it matches the current stream. Paused senders and hidden
windows suppress automatic playback-stall classifications. These classifications
are observations, not proof of a particular cause; for example, a static sender
can produce a video input gap.

`processes.app` and `processes.receiver` contain PID, private bytes, working set,
handle count, and cumulative CPU milliseconds when Windows permits the query.
Compare CPU-time differences over elapsed-time differences for the same PID.
These do not include WebView renderer/GPU subprocesses. A missing process query
is represented as unavailable/null, not zero usage.

The existing `PreviewTelemetry.latencyMs` is a placeholder and is deliberately
excluded. `client.bufferLeadMs` measures buffered playback lead for MSE only;
it is not an end-to-end phone-to-screen latency measurement. WebCodecs diagnosis
uses decoder progress and queue counters. Sequence counters from different
pipeline stages are not necessarily in the same numbering domain.

`flightRecorder.previousRun` retains the last saved run after restarting the app.
Redacted checkpoints live in the app data directory as `flight-recorder.json`
and `flight-recorder.json.bak`. Each is limited to 32 MiB. Normal checkpoints are
written about every 30 seconds; incident creation requests a checkpoint on the
next sampler tick. A sudden process exit can lose the unsaved tail. Export
includes `persistenceError` if the latest checkpoint operation failed. Nothing
is uploaded, and media payloads are not retained by this recorder.

## Reading an incident

| Observation | Investigation |
| --- | --- |
| Video received count advances; decoded count stops | Decoder or delivery stall; inspect client freshness and queue depth |
| Input age rises while audio continues | Video transport or sender state; inspect pause/discontinuity and native control logs |
| Client report age rises while backend samples continue | Frontend reporting, event loop, or visibility interruption |
| Receiver output closes | Native process/output lifecycle; inspect the preceding logs and PID changes |
| Private bytes or handles grow across reconnects | Potential resource leak; compare repeated cycles and a steady baseline |
| Backend samples themselves have large time gaps | PC sleep, sampler scheduling, or backend contention; do not interpret as continuous observation |

## Repeatable test session

Run a moving screen with audio for at least two hours, then repeat lock/unlock,
app switching, orientation changes, and disconnect/reconnect cycles. Mark the
start of a suspicious transition and record its approximate wall-clock time.
Change one condition at a time so incidents can be compared. Exercise a brief
Wi-Fi interruption separately from normal sender pause/resume. Check whether
memory and handle counts settle after reconnects.

Automated Rust tests simulate more than five hours of observations to verify
bounded retention, incident survival after timeline eviction, and pause/reset
handling. They do not reproduce a real iPhone, network failure, or native hang;
the next instrumented real session is still needed to establish the cause.
