# v0.1.5

MirrorSim v0.1.5 is a reliability-focused update for long-running mirroring, app and video transitions, receiver-driven orientation, built-in discovery, and honest protected-picture guidance.

## Highlights

- Follows trustworthy receiver-reported phone orientation while keeping manual Rotate as a temporary override.
- Advertises AirPlay with built-in mDNS, so MirrorSim no longer requires Bonjour for Windows.
- Distinguishes sender-paused pictures from a conservative protected-surface heuristic without claiming DRM as a certainty.
- Refines Console and Minimal mode with clearer connection guidance, consistent status states, complete tooltips, and a cleaner command layout.
- Keeps the existing iPhone audio, phone-volume following, framed captures, recording, fullscreen, updater, and support controls from v0.1.4.

## Fixed and hardened

- Console mode now keeps its title centered, makes the full empty titlebar draggable, removes duplicate controls, and presents connection steps at a readable size in the Session panel.
- Listening, mirroring, recording, and error states now use consistent labels and colors without exposing the receiver adapter identifier in primary UI.
- Preferences can open directly to Capture or Devices, reset scroll position between sections, include a keyboard-shortcut reference, and use a conventional settings cog.
- Disabled capture controls explain when video must become ready, Minimal controls can be restored from the context menu, and keyboard shortcuts require their intended modifiers.
- Console capture notices live with Captures, its inspector remains scrollable at small window sizes, and live telemetry reports the actual source resolution.
- Long Minimal-mode errors wrap and remain readable instead of being truncated.
- Exported diagnostics redact stable device IDs, trust keys, session IDs, and pairing challenge IDs, including occurrences copied into sidecar logs.
- Automatic orientation follows receiver-reported source-screen geometry without mistaking a landscape media surface for a rotated phone; manual Rotate remains available as a temporary override.
- Protected-playback guidance now distinguishes an explicit sender-paused picture from a conservative multi-frame protected-surface heuristic, avoiding warnings for frozen frames, silent black screens, short fades, and detailed dark interfaces.
- Built-in discovery now reports its actual stopped, advertising, or failed state, and Refresh discovery re-registers an active receiver after network changes.
- Receiver discovery uses a private per-installation identity instead of exposing a physical adapter address or sharing a global fallback identity.
- PCM events are format-validated and size-limited at both the native adapter and Rust boundary.
- Invalid or missing audio packets are dropped and rate-limited without changing the live video state or flooding connection history.
- Recoverable receiver warnings no longer own the session state machine or rebuild a healthy video decoder; only explicit stream discontinuities can reset live media.
- The initial connection watchdog retires after the first accepted video frame, so a later recoverable audio fault cannot reset an established mirroring session back to Listening.
- The desktop audio queue is bounded and drops stale frames rather than allowing a stalled UI to grow memory indefinitely.
- Audio scheduling resets after timestamp discontinuities and excessive backlog to stay close to live playback.
- H.264 serialization now runs on a bounded receiver worker so a busy desktop UI cannot back-pressure and lag the iPhone.
- Live AirPlay video now uses a continuous WebCodecs H.264 decoder instead of retaining an ever-growing Media Source buffer, preventing long sessions from exhausting the browser media buffer.
- WebCodecs frames render directly to a persistent canvas instead of depending on a second browser video-presentation pipeline.
- The live canvas is preserved and moved with the video host across Minimal/Console remounts, preventing a healthy decoder from continuing inside a detached window surface.
- Decoder ownership changes are explicit instead of masquerading as an empty queue; stale clients automatically reacquire the stream and preview generations remain monotonic across resets.
- Overlapping development/HMR attachments serialize decoder preparation, closing a race where an already-disposed preview could invalidate the active one.
- Equivalent receiver descriptor refreshes no longer recreate the decoder, and recoverable connection transitions preserve the last drawable frame instead of erasing it.
- Canvas capture is now created only while recording instead of duplicating every decoded frame through an always-on hidden video bridge.
- Standalone AirPlay SPS/PPS changes are staged until the next real IDR, so codec metadata cannot invalidate an otherwise healthy decoder chain.
- Catch-up and stall recovery no longer seek into dependent H.264 frames; AirPlay sessions that provide only one initial IDR keep their decoder continuity.
- Explicit preview rebuilds are primed from a bounded keyframe group when one is available and otherwise report that a fresh Screen Mirroring connection is required instead of loading forever.
- Live playback no longer performs keyframe-unaware 20-second MSE eviction, which could erase the active H.264 dependency chain and freeze on an old frame.
- Preview diagnostics now report buffered ranges, keyframe distance, empty appends, decoder-client recoveries, canvas attachment/context loss, sampled pixel luma, and the latest browser media event/error.
- Frontend decoder diagnostics are retained in exported support reports every two seconds, so a future black-frame report can distinguish handoff, decoding, canvas, and source failures.
- Screenshots retain and capture the last decoded canvas frame across playback errors and preview retries, making freeze reports diagnosable even after the video bridge is torn down.
- Connection-history rows receive collision-resistant IDs and legacy duplicates no longer produce repeated React key errors.
- The native receiver keeps its mirror listener alive when an iPhone cycles the data socket during an app or video transition.
- Mirror-data socket interruptions now leave the AirPlay control session attached while preserving the decoder and last drawable frame; a resumed socket restores the live session without making the user select MirrorSim again.
- A sender pause immediately followed by a closed mirror-data socket no longer remains falsely Live or leaves the last frame looking like an active stream. MirrorSim reports that it is reconnecting and waits for the existing AirPlay session until the iPhone or user disconnects.
- Mirror timing probes now use the protocol's multi-second cadence and a realistic response window instead of retrying roughly 100 times per second when the iPhone takes longer than 1 ms to answer.
- Native diagnostics now preserve more than thirty minutes of pipeline history and record AirPlay control requests, control-socket lifecycle, timing timeouts, and mirror-data generations around an interruption.
- A malformed H.264 access unit is dropped instead of terminating the complete AirPlay session.
- Development diagnostics now retain native transport transitions and two-second video/audio pipeline counters.

## Receiver requirement

This release bundles AirPlayServer v0.4.1 and requires adapter protocol `0.8.0` with the `pcm-audio`, `sender-volume`, `video-geometry`, `video-sender-state`, and `external-dnssd` capabilities.

## Install

Choose one of the attached Windows builds:

- `MirrorSim_*_x64-setup.exe` — recommended NSIS installer.
- `MirrorSim_*_x64_en-US.msi` — MSI package for managed or advanced installations.
- `MirrorSim-portable-*.zip` — portable build with no installation required.

Windows may show a SmartScreen warning because the binaries are updater-signed but are not yet backed by a commercial Windows code-signing certificate. SHA-256 hashes are included in `checksums.txt`, and the GitHub release includes updater artifacts and build-provenance attestations.
