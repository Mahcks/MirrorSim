mod preview_fragments;
mod remux;
mod sidecar;

use crate::preview_fragments::{LivePreviewBuffer, PreviewPushResult, QueuedPreviewSegment};
use crate::remux::RemuxBlueprint;
use crate::sidecar::ReceiverSidecarSpec;
use base64::prelude::{Engine as _, BASE64_STANDARD};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::{
    fs,
    io::{BufRead, BufReader, Write},
    path::{Path, PathBuf},
    process::{Child, ChildStderr, ChildStdin, ChildStdout, Command, Stdio},
    sync::{Arc, Mutex},
    thread,
};
#[cfg(windows)]
use std::os::windows::process::CommandExt;
use tauri::{AppHandle, Emitter, Manager, State};

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

const SESSION_STATUS_EVENT: &str = "session-status";
const PREVIEW_TELEMETRY_EVENT: &str = "preview-telemetry";
const PREVIEW_STREAM_EVENT: &str = "preview-stream";
const RECEIVER_RUNTIME_EVENT: &str = "receiver-runtime";
const PREVIEW_DIAGNOSTICS_EVENT: &str = "preview-diagnostics";

#[derive(Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
enum SessionStatus {
    Idle,
    Discovering,
    Connecting,
    Mirroring,
    Recording,
}

#[derive(Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
enum ReceiverTransport {
    Fixture,
    Airplayserver,
}

#[derive(Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
enum ReceiverRuntimeState {
    Idle,
    Priming,
    Ready,
    Streaming,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SessionSnapshot {
    status: SessionStatus,
    capture_count: u32,
    device_name: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct PreviewTelemetry {
    frame_number: u64,
    fps: u16,
    bitrate_kbps: u32,
    latency_ms: u16,
    activity: f32,
}

#[derive(Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
enum PreviewDeliveryMode {
    StaticPaths,
    CommandStream,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct PreviewStreamDescriptor {
    stream_id: String,
    transport: ReceiverTransport,
    delivery_mode: PreviewDeliveryMode,
    mime_type: String,
    init_segment_path: String,
    media_segment_paths: Vec<String>,
    should_loop: bool,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct PreviewMediaSegmentPayload {
    sequence_number: u32,
    first_sample_index: u32,
    last_sample_index: u32,
    bytes: Vec<u8>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ReceiverRuntimeSnapshot {
    state: ReceiverRuntimeState,
    transport: ReceiverTransport,
    stream_id: String,
    queued_segments: usize,
    last_error: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct PreviewDiagnosticsSnapshot {
    transport: ReceiverTransport,
    init_segment_ready: bool,
    track_timescale: u32,
    pending_samples: usize,
    queued_segments: usize,
    emitted_segments: u32,
    delivered_segments: u32,
    last_access_unit_index: Option<u32>,
    last_access_unit_duration: Option<u32>,
    last_queued_sequence_number: Option<u32>,
    last_queued_first_sample_index: Option<u32>,
    last_queued_last_sample_index: Option<u32>,
    last_queued_duration: Option<u32>,
    last_delivered_sequence_number: Option<u32>,
    last_delivered_first_sample_index: Option<u32>,
    last_delivered_last_sample_index: Option<u32>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct RemuxBlueprintSnapshot {
    transport: ReceiverTransport,
    blueprint: RemuxBlueprint,
}

struct SessionStore {
    sequence: u64,
    active_session_id: Option<String>,
    snapshot: SessionSnapshot,
    preview: PreviewTelemetry,
    preview_stream: PreviewStreamDescriptor,
    live_preview_buffer: LivePreviewBuffer,
    remux_blueprint: RemuxBlueprint,
    receiver_runtime: ReceiverRuntimeSnapshot,
    preview_diagnostics: PreviewDiagnosticsSnapshot,
}

struct SidecarRuntime {
    child: Child,
    stdin: ChildStdin,
}

impl SidecarRuntime {
    fn send_command(&mut self, command: serde_json::Value) -> CommandResult<()> {
        serde_json::to_writer(&mut self.stdin, &command).map_err(|error| error.to_string())?;
        self.stdin.write_all(b"\n").map_err(|error| error.to_string())?;
        self.stdin.flush().map_err(|error| error.to_string())
    }
}

impl Drop for SidecarRuntime {
    fn drop(&mut self) {
        let _ = self.send_command(json!({ "name": "shutdown" }));
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

struct AppState {
    inner: Arc<Mutex<SessionStore>>,
    sidecar: Arc<Mutex<Option<SidecarRuntime>>>,
}

impl Default for AppState {
    fn default() -> Self {
        let remux_blueprint = RemuxBlueprint::fixture_preview();
        let preview_stream = preview_stream_from_blueprint(&remux_blueprint, ReceiverTransport::Fixture);

        Self {
            inner: Arc::new(Mutex::new(SessionStore {
                sequence: 0,
                active_session_id: None,
                snapshot: SessionSnapshot {
                    status: SessionStatus::Idle,
                    capture_count: 0,
                    device_name: String::from("iPhone 15 Pro"),
                },
                preview: PreviewTelemetry {
                    frame_number: 0,
                    fps: 0,
                    bitrate_kbps: 0,
                    latency_ms: 0,
                    activity: 0.0,
                },
                preview_stream,
                live_preview_buffer: LivePreviewBuffer::new(),
                remux_blueprint: remux_blueprint.clone(),
                receiver_runtime: ReceiverRuntimeSnapshot {
                    state: ReceiverRuntimeState::Idle,
                    transport: ReceiverTransport::Fixture,
                    stream_id: remux_blueprint.stream_id.clone(),
                    queued_segments: 0,
                    last_error: None,
                },
                preview_diagnostics: PreviewDiagnosticsSnapshot {
                    transport: ReceiverTransport::Fixture,
                    init_segment_ready: true,
                    track_timescale: remux_blueprint.track.timescale,
                    pending_samples: 0,
                    queued_segments: remux_blueprint.queued_segment_count(),
                    emitted_segments: 0,
                    delivered_segments: 0,
                    last_access_unit_index: None,
                    last_access_unit_duration: None,
                    last_queued_sequence_number: None,
                    last_queued_first_sample_index: None,
                    last_queued_last_sample_index: None,
                    last_queued_duration: None,
                    last_delivered_sequence_number: None,
                    last_delivered_first_sample_index: None,
                    last_delivered_last_sample_index: None,
                },
            })),
            sidecar: Arc::new(Mutex::new(None)),
        }
    }
}

#[derive(Deserialize)]
#[serde(tag = "name", rename_all = "snake_case")]
enum SidecarEvent {
    ReceiverReady {
        receiver_id: String,
        protocol_version: String,
        capabilities: Vec<String>,
    },
    SessionStarted {
        session_id: String,
        stream_id: String,
        device_name: String,
    },
    VideoAccessUnit {
        stream_id: String,
        sample_index: u32,
        keyframe: bool,
        pts: u64,
        dts: u64,
        duration: u32,
        #[serde(rename = "payloadBase64")]
        payload_base64: String,
    },
    StreamDiscontinuity {
        stream_id: String,
        reason: String,
        requires_init_segment_refresh: bool,
    },
    ReceiverError {
        code: String,
        message: String,
        recoverable: bool,
    },
}

type CommandResult<T> = Result<T, String>;

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "kebab-case")]
enum ScreenshotSaveLocation {
    Pictures,
    Documents,
    Downloads,
    Custom,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SaveScreenshotRequest {
    file_name: String,
    png_base64: String,
    location: ScreenshotSaveLocation,
    custom_directory: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SaveRecordingRequest {
    file_name: String,
    media_base64: String,
    location: ScreenshotSaveLocation,
    custom_directory: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SavedScreenshot {
    file_name: String,
    file_path: String,
}

fn resolve_capture_directory(
    app: &AppHandle,
    location: ScreenshotSaveLocation,
    custom_directory: Option<&str>,
) -> CommandResult<PathBuf> {
    let resolver = app.path();
    let directory = match location {
        ScreenshotSaveLocation::Pictures => resolver
            .picture_dir()
            .or_else(|_| resolver.document_dir())
            .or_else(|_| resolver.download_dir()),
        ScreenshotSaveLocation::Documents => resolver
            .document_dir()
            .or_else(|_| resolver.picture_dir())
            .or_else(|_| resolver.download_dir()),
        ScreenshotSaveLocation::Downloads => resolver
            .download_dir()
            .or_else(|_| resolver.document_dir())
            .or_else(|_| resolver.picture_dir()),
        ScreenshotSaveLocation::Custom => {
            let directory = custom_directory
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .ok_or_else(|| String::from("custom capture directory is empty"))?;

            return Ok(PathBuf::from(directory));
        }
    }
    .map_err(|error| error.to_string())?;

    Ok(directory.join("MirrorSim"))
}

fn preview_stream_from_blueprint(
    blueprint: &RemuxBlueprint,
    transport: ReceiverTransport,
) -> PreviewStreamDescriptor {
    PreviewStreamDescriptor {
        stream_id: blueprint.stream_id.clone(),
        transport,
        delivery_mode: match transport {
            ReceiverTransport::Fixture => PreviewDeliveryMode::StaticPaths,
            ReceiverTransport::Airplayserver => PreviewDeliveryMode::CommandStream,
        },
        mime_type: blueprint.mime_type.clone(),
        init_segment_path: blueprint.init_segment_path.clone(),
        media_segment_paths: blueprint
            .media_segments
            .iter()
            .map(|segment| segment.file_path.clone())
            .collect(),
        should_loop: blueprint.should_loop,
    }
}

fn emit_preview_stream(app: &AppHandle, preview_stream: &PreviewStreamDescriptor) -> CommandResult<()> {
    app.emit(PREVIEW_STREAM_EVENT, preview_stream.clone())
        .map_err(|error| error.to_string())
}

fn emit_session_status(app: &AppHandle, snapshot: &SessionSnapshot) -> CommandResult<()> {
    app.emit(SESSION_STATUS_EVENT, snapshot.clone())
        .map_err(|error| error.to_string())
}

fn emit_preview_telemetry(app: &AppHandle, preview: &PreviewTelemetry) -> CommandResult<()> {
    app.emit(PREVIEW_TELEMETRY_EVENT, preview.clone())
        .map_err(|error| error.to_string())
}

fn emit_receiver_runtime(app: &AppHandle, receiver_runtime: &ReceiverRuntimeSnapshot) -> CommandResult<()> {
    app.emit(RECEIVER_RUNTIME_EVENT, receiver_runtime.clone())
        .map_err(|error| error.to_string())
}

fn emit_preview_diagnostics(app: &AppHandle, preview_diagnostics: &PreviewDiagnosticsSnapshot) -> CommandResult<()> {
    app.emit(PREVIEW_DIAGNOSTICS_EVENT, preview_diagnostics.clone())
        .map_err(|error| error.to_string())
}

fn emit_state_updates(
    app: &AppHandle,
    snapshot: Option<SessionSnapshot>,
    preview: Option<PreviewTelemetry>,
    preview_stream: Option<PreviewStreamDescriptor>,
    receiver_runtime: Option<ReceiverRuntimeSnapshot>,
    preview_diagnostics: Option<PreviewDiagnosticsSnapshot>,
) -> CommandResult<()> {
    if let Some(snapshot) = snapshot.as_ref() {
        emit_session_status(app, snapshot)?;
    }

    if let Some(preview) = preview.as_ref() {
        emit_preview_telemetry(app, preview)?;
    }

    if let Some(preview_stream) = preview_stream.as_ref() {
        emit_preview_stream(app, preview_stream)?;
    }

    if let Some(receiver_runtime) = receiver_runtime.as_ref() {
        emit_receiver_runtime(app, receiver_runtime)?;
    }

    if let Some(preview_diagnostics) = preview_diagnostics.as_ref() {
        emit_preview_diagnostics(app, preview_diagnostics)?;
    }

    Ok(())
}

fn sync_preview_diagnostics(store: &mut SessionStore) {
    store.preview_diagnostics.transport = store.receiver_runtime.transport;
    store.preview_diagnostics.track_timescale = store.remux_blueprint.track.timescale;
    store.preview_diagnostics.pending_samples = store.live_preview_buffer.pending_sample_count();
    store.preview_diagnostics.queued_segments = match store.receiver_runtime.transport {
        ReceiverTransport::Fixture => store.remux_blueprint.queued_segment_count(),
        ReceiverTransport::Airplayserver => store.live_preview_buffer.queued_segment_count(),
    };
    store.preview_diagnostics.init_segment_ready = match store.receiver_runtime.transport {
        ReceiverTransport::Fixture => true,
        ReceiverTransport::Airplayserver => store.live_preview_buffer.has_init_segment(),
    };
}

fn reset_preview_diagnostics(store: &mut SessionStore, transport: ReceiverTransport, init_segment_ready: bool) {
    store.preview_diagnostics = PreviewDiagnosticsSnapshot {
        transport,
        init_segment_ready,
        track_timescale: store.remux_blueprint.track.timescale,
        pending_samples: 0,
        queued_segments: if transport == ReceiverTransport::Fixture {
            store.remux_blueprint.queued_segment_count()
        } else {
            0
        },
        emitted_segments: 0,
        delivered_segments: 0,
        last_access_unit_index: None,
        last_access_unit_duration: None,
        last_queued_sequence_number: None,
        last_queued_first_sample_index: None,
        last_queued_last_sample_index: None,
        last_queued_duration: None,
        last_delivered_sequence_number: None,
        last_delivered_first_sample_index: None,
        last_delivered_last_sample_index: None,
    };
    sync_preview_diagnostics(store);
}

fn reset_preview(store: &mut SessionStore) {
    store.preview = PreviewTelemetry {
        frame_number: 0,
        fps: 0,
        bitrate_kbps: 0,
        latency_ms: 0,
        activity: 0.0,
    };
}

fn reset_fixture_transport(store: &mut SessionStore) {
    let remux_blueprint = RemuxBlueprint::fixture_preview();
    store.preview_stream = preview_stream_from_blueprint(&remux_blueprint, ReceiverTransport::Fixture);
    store.live_preview_buffer.reset();
    store.remux_blueprint = remux_blueprint.clone();
    store.receiver_runtime.transport = ReceiverTransport::Fixture;
    store.receiver_runtime.stream_id = remux_blueprint.stream_id;
    reset_preview_diagnostics(store, ReceiverTransport::Fixture, true);
}

fn prepare_live_transport(store: &mut SessionStore, stream_id: String) {
    store.live_preview_buffer.reset();
    store.remux_blueprint = RemuxBlueprint::live_preview(stream_id.clone());
    store.preview_stream = preview_stream_from_blueprint(&store.remux_blueprint, ReceiverTransport::Airplayserver);
    store.receiver_runtime.transport = ReceiverTransport::Airplayserver;
    store.receiver_runtime.stream_id = stream_id;
    reset_preview_diagnostics(store, ReceiverTransport::Airplayserver, false);
}

fn refresh_live_preview_descriptor(store: &mut SessionStore) {
    store.preview_stream = preview_stream_from_blueprint(&store.remux_blueprint, ReceiverTransport::Airplayserver);
}

fn set_receiver_runtime_state(store: &mut SessionStore, state: ReceiverRuntimeState) {
    store.receiver_runtime.state = state;
    store.receiver_runtime.queued_segments = match state {
        ReceiverRuntimeState::Idle => 0,
        ReceiverRuntimeState::Priming => 1,
        ReceiverRuntimeState::Ready | ReceiverRuntimeState::Streaming => match store.receiver_runtime.transport {
            ReceiverTransport::Fixture => store.remux_blueprint.queued_segment_count(),
            ReceiverTransport::Airplayserver => store.remux_blueprint.buffered_access_unit_count(),
        },
    };
    store.receiver_runtime.last_error = None;
    sync_preview_diagnostics(store);
}

fn preview_fps_from_duration(duration: u32, timescale: u32) -> u16 {
    if duration == 0 {
        return 0;
    }

    ((timescale as f32 / duration as f32).round() as u16).max(1)
}

fn preview_bitrate_kbps(size_bytes: usize, duration: u32, timescale: u32) -> u32 {
    if duration == 0 {
        return 0;
    }

    ((size_bytes as u64 * 8 * timescale as u64) / (duration as u64 * 1_000)) as u32
}

fn preview_activity(size_bytes: usize) -> f32 {
    ((size_bytes as f32 / 16_000.0).clamp(0.15, 1.0) * 10.0).round() / 10.0
}

fn push_sidecar_candidates(candidates: &mut Vec<PathBuf>, base: &Path, relative: &Path) {
    candidates.push(base.join(relative));

    if let Ok(stripped) = relative.strip_prefix("receivers") {
        candidates.push(base.join(stripped));
    }

    let up_dir = base.join("_up_");
    candidates.push(up_dir.join(relative));

    if let Ok(stripped) = relative.strip_prefix("receivers") {
        candidates.push(up_dir.join(stripped));
    }
}

fn resolve_sidecar_path(app: &AppHandle, relative_path: &str) -> CommandResult<PathBuf> {
    let current_dir = std::env::current_dir().map_err(|error| error.to_string())?;
    let relative = Path::new(relative_path);
    let mut candidates = Vec::new();

    push_sidecar_candidates(&mut candidates, &current_dir, relative);
    push_sidecar_candidates(&mut candidates, &current_dir.join("src-tauri"), relative);

    if let Some(parent) = current_dir.parent() {
        push_sidecar_candidates(&mut candidates, parent, relative);
    }

    if let Ok(resource_dir) = app.path().resource_dir() {
        push_sidecar_candidates(&mut candidates, &resource_dir, relative);
    }

    if let Ok(executable_path) = std::env::current_exe() {
        if let Some(executable_dir) = executable_path.parent() {
            push_sidecar_candidates(&mut candidates, executable_dir, relative);
        }
    }

    candidates.sort();
    candidates.dedup();

    for candidate in &candidates {
        if candidate.exists() {
            return Ok(candidate.clone());
        }
    }

    let searched_paths = candidates
        .iter()
        .map(|candidate| candidate.display().to_string())
        .collect::<Vec<_>>()
        .join(", ");

    Err(format!(
        "unable to resolve receiver sidecar path '{}'. Place the receiver runtime under receivers/AirPlayServer for development and bundle it for release. Searched: {}",
        relative_path,
        searched_paths
    ))
}

fn emit_runtime_error(
    app: &AppHandle,
    store: &Arc<Mutex<SessionStore>>,
    message: String,
    recoverable: bool,
) -> CommandResult<()> {
    let (snapshot, preview, preview_stream, receiver_runtime, preview_diagnostics) = {
        let mut guard = store.lock().map_err(|error| error.to_string())?;

        if recoverable {
            if guard.snapshot.status != SessionStatus::Idle {
                guard.snapshot.status = SessionStatus::Connecting;
            }
            guard.receiver_runtime.transport = ReceiverTransport::Airplayserver;
            set_receiver_runtime_state(&mut guard, ReceiverRuntimeState::Ready);
        } else {
            guard.snapshot.status = SessionStatus::Idle;
            guard.active_session_id = None;
            reset_preview(&mut guard);
            reset_fixture_transport(&mut guard);
            set_receiver_runtime_state(&mut guard, ReceiverRuntimeState::Idle);
        }

        guard.receiver_runtime.last_error = Some(message);
        sync_preview_diagnostics(&mut guard);

        (
            guard.snapshot.clone(),
            guard.preview.clone(),
            guard.preview_stream.clone(),
            guard.receiver_runtime.clone(),
            guard.preview_diagnostics.clone(),
        )
    };

    emit_state_updates(
        app,
        Some(snapshot),
        Some(preview),
        Some(preview_stream),
        Some(receiver_runtime),
        Some(preview_diagnostics),
    )
}

fn handle_sidecar_event(
    app: &AppHandle,
    store: &Arc<Mutex<SessionStore>>,
    sidecar: &Arc<Mutex<Option<SidecarRuntime>>>,
    event: SidecarEvent,
) -> CommandResult<()> {
    let mut request_keyframe: Option<(String, String)> = None;

    let (snapshot, preview, preview_stream, receiver_runtime, preview_diagnostics) = {
        let mut guard = store.lock().map_err(|error| error.to_string())?;
        let mut emit_snapshot = false;
        let mut emit_preview = false;
        let mut emit_preview_stream = false;

        match event {
            SidecarEvent::ReceiverReady {
                receiver_id,
                protocol_version,
                capabilities,
            } => {
                guard.receiver_runtime.transport = ReceiverTransport::Airplayserver;
                if guard.snapshot.status != SessionStatus::Idle {
                    guard.snapshot.status = SessionStatus::Connecting;
                    emit_snapshot = true;
                }

                let ready_note = format!(
                    "{} {} ({})",
                    receiver_id,
                    protocol_version,
                    capabilities.join(", ")
                );
                set_receiver_runtime_state(&mut guard, ReceiverRuntimeState::Ready);
                guard.receiver_runtime.last_error = Some(ready_note);
            }
            SidecarEvent::SessionStarted {
                session_id,
                stream_id,
                device_name,
            } => {
                guard.active_session_id = Some(session_id);
                guard.snapshot.device_name = device_name;
                guard.snapshot.status = SessionStatus::Connecting;
                prepare_live_transport(&mut guard, stream_id);
                set_receiver_runtime_state(&mut guard, ReceiverRuntimeState::Ready);
                guard.receiver_runtime.last_error = Some(String::from(
                    "receiver connected; waiting for the first H.264 frame from the iPhone",
                ));
                emit_snapshot = true;
                emit_preview_stream = true;
            }
            SidecarEvent::VideoAccessUnit {
                stream_id,
                sample_index,
                keyframe,
                pts,
                dts,
                duration,
                payload_base64,
            } => {
                if guard.receiver_runtime.stream_id != stream_id {
                    prepare_live_transport(&mut guard, stream_id.clone());
                    emit_preview_stream = true;
                }

                let payload = BASE64_STANDARD
                    .decode(payload_base64.as_bytes())
                    .map_err(|error| format!("failed to decode receiver payload: {}", error))?;
                let size_bytes = payload.len();
                guard.remux_blueprint.push_access_unit(sample_index, size_bytes, keyframe, dts, pts, duration);
                let push_result: PreviewPushResult = guard
                    .live_preview_buffer
                    .push_access_unit(sample_index, payload, keyframe, dts, pts, duration)?;
                guard.preview_diagnostics.last_access_unit_index = Some(sample_index);
                guard.preview_diagnostics.last_access_unit_duration = Some(duration);
                if push_result.init_segment_became_available {
                    if let Some(track) = guard.live_preview_buffer.track_config() {
                        guard.remux_blueprint.track = track.clone();
                        guard.remux_blueprint.mime_type = format!("video/mp4; codecs=\"{}\"", track.codec);
                        refresh_live_preview_descriptor(&mut guard);
                        emit_preview_stream = true;
                    }
                }

                if let Some(segment) = push_result.emitted_segment {
                    guard.preview_diagnostics.emitted_segments += 1;
                    guard.preview_diagnostics.last_queued_sequence_number = Some(segment.sequence_number);
                    guard.preview_diagnostics.last_queued_first_sample_index = Some(segment.first_sample_index);
                    guard.preview_diagnostics.last_queued_last_sample_index = Some(segment.last_sample_index);
                    guard.preview_diagnostics.last_queued_duration = Some(segment.duration);
                }

                if !push_result.sample_enqueued {
                    guard.snapshot.status = SessionStatus::Connecting;
                    guard.receiver_runtime.transport = ReceiverTransport::Airplayserver;
                    guard.receiver_runtime.stream_id = stream_id;
                    guard.receiver_runtime.state = ReceiverRuntimeState::Ready;
                    guard.receiver_runtime.queued_segments = guard.live_preview_buffer.queued_segment_count();
                    guard.receiver_runtime.last_error = Some(String::from(
                        "receiver initialized; waiting for the first decodable video frame",
                    ));

                    emit_snapshot = true;
                } else {
                    if guard.snapshot.status != SessionStatus::Recording {
                        guard.snapshot.status = SessionStatus::Mirroring;
                    }

                    guard.receiver_runtime.transport = ReceiverTransport::Airplayserver;
                    guard.receiver_runtime.stream_id = stream_id;
                    guard.receiver_runtime.state = ReceiverRuntimeState::Streaming;
                    guard.receiver_runtime.queued_segments = guard.live_preview_buffer.queued_segment_count();
                    guard.receiver_runtime.last_error = None;

                    guard.preview.frame_number = sample_index as u64 + 1;
                    let preview_timescale = guard.remux_blueprint.track.timescale;
                    guard.preview.fps = preview_fps_from_duration(duration, preview_timescale);
                    guard.preview.bitrate_kbps = preview_bitrate_kbps(size_bytes, duration, preview_timescale);
                    guard.preview.latency_ms = 18 + ((sample_index % 5) as u16 * 2);
                    guard.preview.activity = preview_activity(size_bytes);

                    emit_snapshot = true;
                    emit_preview = true;
                }

                sync_preview_diagnostics(&mut guard);
            }
            SidecarEvent::StreamDiscontinuity {
                stream_id,
                reason,
                requires_init_segment_refresh,
            } => {
                prepare_live_transport(&mut guard, stream_id.clone());
                guard.remux_blueprint.reset_live_preview(stream_id.clone());
                guard.receiver_runtime.state = ReceiverRuntimeState::Ready;
                guard.receiver_runtime.queued_segments = 0;
                guard.receiver_runtime.last_error = Some(format!("stream discontinuity: {}", reason));

                if matches!(guard.snapshot.status, SessionStatus::Mirroring | SessionStatus::Recording) {
                    guard.snapshot.status = SessionStatus::Connecting;
                    emit_snapshot = true;
                }

                if requires_init_segment_refresh {
                    reset_preview(&mut guard);
                    emit_preview = true;
                    emit_preview_stream = true;
                    request_keyframe = Some((stream_id, reason));
                }

                sync_preview_diagnostics(&mut guard);

            }
            SidecarEvent::ReceiverError {
                code,
                message,
                recoverable,
            } => {
                drop(guard);
                return emit_runtime_error(app, store, format!("{}: {}", code, message), recoverable);
            }
        }

        (
            emit_snapshot.then(|| guard.snapshot.clone()),
            emit_preview.then(|| guard.preview.clone()),
            emit_preview_stream.then(|| guard.preview_stream.clone()),
            Some(guard.receiver_runtime.clone()),
            Some(guard.preview_diagnostics.clone()),
        )
    };

    emit_state_updates(app, snapshot, preview, preview_stream, receiver_runtime, preview_diagnostics)?;

    if let Some((stream_id, reason)) = request_keyframe {
        let _ = send_sidecar_command(
            sidecar,
            json!({
                "name": "request_keyframe",
                "stream_id": stream_id,
                "reason": reason,
            }),
        );
    }

    Ok(())
}

fn spawn_sidecar_stdout_loop(
    app: AppHandle,
    store: Arc<Mutex<SessionStore>>,
    sidecar: Arc<Mutex<Option<SidecarRuntime>>>,
    stdout: ChildStdout,
) {
    thread::spawn(move || {
        let reader = BufReader::new(stdout);

        for line in reader.lines() {
            let line = match line {
                Ok(line) => line,
                Err(error) => {
                    let _ = emit_runtime_error(&app, &store, format!("receiver output error: {}", error), true);
                    break;
                }
            };

            if line.trim().is_empty() {
                continue;
            }

            match serde_json::from_str::<SidecarEvent>(&line) {
                Ok(event) => {
                    let _ = handle_sidecar_event(&app, &store, &sidecar, event);
                }
                Err(error) => {
                    let _ = emit_runtime_error(
                        &app,
                        &store,
                        format!("receiver emitted malformed event: {}", error),
                        true,
                    );
                }
            }
        }

        if let Ok(mut guard) = sidecar.lock() {
            *guard = None;
        }

        let is_idle = match store.lock() {
            Ok(guard) => guard.snapshot.status == SessionStatus::Idle,
            Err(_) => true,
        };

        if !is_idle {
            let _ = emit_runtime_error(&app, &store, String::from("receiver sidecar exited unexpectedly"), false);
        }
    });
}

fn spawn_sidecar_stderr_loop(app: AppHandle, store: Arc<Mutex<SessionStore>>, stderr: ChildStderr) {
    thread::spawn(move || {
        let reader = BufReader::new(stderr);

        for line in reader.lines() {
            let line = match line {
                Ok(line) => line,
                Err(_) => break,
            };

            let trimmed = line.trim();
            if trimmed.is_empty() {
                continue;
            }

            let _ = emit_runtime_error(&app, &store, format!("receiver stderr: {}", trimmed), true);
        }
    });
}

fn ensure_sidecar_runtime(app: &AppHandle, state: &AppState) -> CommandResult<bool> {
    let mut sidecar_guard = state.sidecar.lock().map_err(|error| error.to_string())?;
    if sidecar_guard.is_some() {
        return Ok(false);
    }

    let spec = ReceiverSidecarSpec::direct_receiver_boundary();
    let executable = resolve_sidecar_path(app, &spec.launch.executable)?;
    let working_directory = resolve_sidecar_path(app, &spec.launch.working_directory)?;

    let mut command = Command::new(&executable);
    command
        .args(&spec.launch.args)
        .current_dir(working_directory)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    #[cfg(windows)]
    command.creation_flags(CREATE_NO_WINDOW);

    let mut child = command
        .spawn()
        .map_err(|error| format!("failed to launch receiver sidecar '{}': {}", executable.display(), error))?;

    let stdin = child.stdin.take().ok_or_else(|| String::from("receiver sidecar stdin was unavailable"))?;
    let stdout = child.stdout.take().ok_or_else(|| String::from("receiver sidecar stdout was unavailable"))?;
    let stderr = child.stderr.take().ok_or_else(|| String::from("receiver sidecar stderr was unavailable"))?;

    spawn_sidecar_stdout_loop(app.clone(), state.inner.clone(), state.sidecar.clone(), stdout);
    spawn_sidecar_stderr_loop(app.clone(), state.inner.clone(), stderr);

    *sidecar_guard = Some(SidecarRuntime { child, stdin });
    Ok(true)
}

fn send_sidecar_command(
    sidecar: &Arc<Mutex<Option<SidecarRuntime>>>,
    command: serde_json::Value,
) -> CommandResult<()> {
    let mut guard = sidecar.lock().map_err(|error| error.to_string())?;
    let runtime = guard
        .as_mut()
        .ok_or_else(|| String::from("receiver sidecar is not running"))?;

    runtime.send_command(command)
}

#[tauri::command]
fn get_session_snapshot(state: State<'_, AppState>) -> CommandResult<SessionSnapshot> {
    let guard = state.inner.lock().map_err(|error| error.to_string())?;
    Ok(guard.snapshot.clone())
}

#[tauri::command]
fn get_preview_telemetry(state: State<'_, AppState>) -> CommandResult<PreviewTelemetry> {
    let guard = state.inner.lock().map_err(|error| error.to_string())?;
    Ok(guard.preview.clone())
}

#[tauri::command]
fn get_preview_stream_descriptor(state: State<'_, AppState>) -> CommandResult<PreviewStreamDescriptor> {
    let guard = state.inner.lock().map_err(|error| error.to_string())?;
    Ok(guard.preview_stream.clone())
}

#[tauri::command]
fn get_preview_init_segment(state: State<'_, AppState>) -> CommandResult<Option<Vec<u8>>> {
    let guard = state.inner.lock().map_err(|error| error.to_string())?;
    Ok(guard.live_preview_buffer.init_segment_bytes())
}

#[tauri::command]
fn take_preview_media_segment(
    app: AppHandle,
    state: State<'_, AppState>,
) -> CommandResult<Option<PreviewMediaSegmentPayload>> {
    let (payload, receiver_runtime, preview_diagnostics) = {
        let mut guard = state.inner.lock().map_err(|error| error.to_string())?;
        let payload = guard.live_preview_buffer.take_next_segment().map(|segment: QueuedPreviewSegment| {
            guard.preview_diagnostics.delivered_segments += 1;
            guard.preview_diagnostics.last_delivered_sequence_number = Some(segment.descriptor.sequence_number);
            guard.preview_diagnostics.last_delivered_first_sample_index = Some(segment.descriptor.first_sample_index);
            guard.preview_diagnostics.last_delivered_last_sample_index = Some(segment.descriptor.last_sample_index);

            PreviewMediaSegmentPayload {
                sequence_number: segment.descriptor.sequence_number,
                first_sample_index: segment.descriptor.first_sample_index,
                last_sample_index: segment.descriptor.last_sample_index,
                bytes: segment.bytes,
            }
        });
        guard.receiver_runtime.queued_segments = guard.live_preview_buffer.queued_segment_count();
        sync_preview_diagnostics(&mut guard);
        (payload, guard.receiver_runtime.clone(), guard.preview_diagnostics.clone())
    };

    emit_receiver_runtime(&app, &receiver_runtime)?;
    emit_preview_diagnostics(&app, &preview_diagnostics)?;
    Ok(payload)
}

#[tauri::command]
fn get_remux_blueprint(state: State<'_, AppState>) -> CommandResult<RemuxBlueprintSnapshot> {
    let guard = state.inner.lock().map_err(|error| error.to_string())?;
    Ok(RemuxBlueprintSnapshot {
        transport: guard.receiver_runtime.transport,
        blueprint: guard.remux_blueprint.clone(),
    })
}

#[tauri::command]
fn get_receiver_sidecar_spec() -> CommandResult<ReceiverSidecarSpec> {
    Ok(ReceiverSidecarSpec::direct_receiver_boundary())
}

#[tauri::command]
fn get_receiver_runtime(state: State<'_, AppState>) -> CommandResult<ReceiverRuntimeSnapshot> {
    let guard = state.inner.lock().map_err(|error| error.to_string())?;
    Ok(guard.receiver_runtime.clone())
}

#[tauri::command]
fn get_preview_diagnostics(state: State<'_, AppState>) -> CommandResult<PreviewDiagnosticsSnapshot> {
    let guard = state.inner.lock().map_err(|error| error.to_string())?;
    Ok(guard.preview_diagnostics.clone())
}

#[tauri::command]
fn start_session(app: AppHandle, state: State<'_, AppState>) -> CommandResult<SessionSnapshot> {
    let sidecar_was_running = state
        .sidecar
        .lock()
        .map_err(|error| error.to_string())?
        .is_some();

    let (snapshot, preview, preview_stream, receiver_runtime, preview_diagnostics, session_id, stream_id, should_start) = {
        let mut guard = state.inner.lock().map_err(|error| error.to_string())?;

        let should_start = guard.snapshot.status == SessionStatus::Idle;

        let session_id = format!("session-{:04}", guard.sequence + 1);
        let stream_id = format!("airplay-stream-{:04}", guard.sequence + 1);

        if should_start {
            guard.sequence += 1;
            guard.active_session_id = Some(session_id.clone());
            guard.snapshot.status = SessionStatus::Discovering;
            reset_preview(&mut guard);
            prepare_live_transport(&mut guard, stream_id.clone());
            set_receiver_runtime_state(&mut guard, ReceiverRuntimeState::Priming);

            if sidecar_was_running {
                guard.snapshot.status = SessionStatus::Connecting;
                set_receiver_runtime_state(&mut guard, ReceiverRuntimeState::Ready);
            }
        }

        (
            guard.snapshot.clone(),
            guard.preview.clone(),
            guard.preview_stream.clone(),
            guard.receiver_runtime.clone(),
            guard.preview_diagnostics.clone(),
            session_id,
            stream_id,
            should_start,
        )
    };

    emit_state_updates(
        &app,
        Some(snapshot.clone()),
        Some(preview),
        Some(preview_stream),
        Some(receiver_runtime),
        Some(preview_diagnostics),
    )?;

    if should_start {
        if let Err(error) = ensure_sidecar_runtime(&app, &state) {
            emit_runtime_error(&app, &state.inner, error.clone(), false)?;
            return Err(error);
        }

        if let Err(error) = send_sidecar_command(
            &state.sidecar,
            json!({
                "name": "start_session",
                "session_id": session_id,
                "expected_stream_id": stream_id,
                "device_hint": snapshot.device_name,
            }),
        ) {
            emit_runtime_error(&app, &state.inner, error.clone(), false)?;
            return Err(error);
        }
    }

    Ok(snapshot)
}

#[tauri::command]
fn reconnect_session(app: AppHandle, state: State<'_, AppState>) -> CommandResult<SessionSnapshot> {
    let active_session_id = {
        let guard = state.inner.lock().map_err(|error| error.to_string())?;
        guard.active_session_id.clone()
    };

    if let Some(session_id) = active_session_id {
        let _ = send_sidecar_command(&state.sidecar, json!({
            "name": "stop_session",
            "session_id": session_id,
        }));
    }

    let sidecar_was_running = state
        .sidecar
        .lock()
        .map_err(|error| error.to_string())?
        .is_some();

    let (snapshot, preview, preview_stream, receiver_runtime, preview_diagnostics, session_id, stream_id) = {
        let mut guard = state.inner.lock().map_err(|error| error.to_string())?;

        guard.sequence += 1;

        let session_id = format!("session-{:04}", guard.sequence);
        let stream_id = format!("airplay-stream-{:04}", guard.sequence);

        guard.active_session_id = Some(session_id.clone());
        reset_preview(&mut guard);
        prepare_live_transport(&mut guard, stream_id.clone());

        if sidecar_was_running {
            guard.snapshot.status = SessionStatus::Connecting;
            set_receiver_runtime_state(&mut guard, ReceiverRuntimeState::Ready);
        } else {
            guard.snapshot.status = SessionStatus::Discovering;
            set_receiver_runtime_state(&mut guard, ReceiverRuntimeState::Priming);
        }

        (
            guard.snapshot.clone(),
            guard.preview.clone(),
            guard.preview_stream.clone(),
            guard.receiver_runtime.clone(),
            guard.preview_diagnostics.clone(),
            session_id,
            stream_id,
        )
    };

    emit_state_updates(
        &app,
        Some(snapshot.clone()),
        Some(preview),
        Some(preview_stream),
        Some(receiver_runtime),
        Some(preview_diagnostics),
    )?;

    if let Err(error) = ensure_sidecar_runtime(&app, &state) {
        emit_runtime_error(&app, &state.inner, error.clone(), false)?;
        return Err(error);
    }

    if let Err(error) = send_sidecar_command(
        &state.sidecar,
        json!({
            "name": "start_session",
            "session_id": session_id,
            "expected_stream_id": stream_id,
            "device_hint": snapshot.device_name,
        }),
    ) {
        emit_runtime_error(&app, &state.inner, error.clone(), false)?;
        return Err(error);
    }

    Ok(snapshot)
}

#[tauri::command]
fn stop_session(app: AppHandle, state: State<'_, AppState>) -> CommandResult<SessionSnapshot> {
    let active_session_id = {
        let guard = state.inner.lock().map_err(|error| error.to_string())?;
        guard.active_session_id.clone()
    };

    if let Some(session_id) = active_session_id {
        let _ = send_sidecar_command(&state.sidecar, json!({
            "name": "stop_session",
            "session_id": session_id,
        }));
    }

    let (snapshot, preview, preview_stream, receiver_runtime, preview_diagnostics) = {
        let mut guard = state.inner.lock().map_err(|error| error.to_string())?;
        guard.sequence += 1;
        guard.active_session_id = None;
        guard.snapshot.status = SessionStatus::Idle;
        reset_preview(&mut guard);
        reset_fixture_transport(&mut guard);
        set_receiver_runtime_state(&mut guard, ReceiverRuntimeState::Idle);
        (
            guard.snapshot.clone(),
            guard.preview.clone(),
            guard.preview_stream.clone(),
            guard.receiver_runtime.clone(),
            guard.preview_diagnostics.clone(),
        )
    };

    emit_state_updates(
        &app,
        Some(snapshot.clone()),
        Some(preview),
        Some(preview_stream),
        Some(receiver_runtime),
        Some(preview_diagnostics),
    )?;
    Ok(snapshot)
}

#[tauri::command]
fn take_screenshot(app: AppHandle, state: State<'_, AppState>) -> CommandResult<SessionSnapshot> {
    let snapshot = {
        let mut guard = state.inner.lock().map_err(|error| error.to_string())?;

        if !matches!(guard.snapshot.status, SessionStatus::Mirroring | SessionStatus::Recording) {
            return Err(String::from("session is not ready for screenshots"));
        }

        guard.snapshot.capture_count += 1;
        guard.snapshot.clone()
    };

    emit_session_status(&app, &snapshot)?;
    Ok(snapshot)
}

#[tauri::command]
fn save_screenshot(app: AppHandle, request: SaveScreenshotRequest) -> CommandResult<SavedScreenshot> {
    let png_bytes = BASE64_STANDARD
        .decode(request.png_base64.as_bytes())
        .map_err(|error| error.to_string())?;

    let directory = resolve_capture_directory(&app, request.location, request.custom_directory.as_deref())?;
    fs::create_dir_all(&directory).map_err(|error| error.to_string())?;

    let file_path = directory.join(&request.file_name);
    fs::write(&file_path, png_bytes).map_err(|error| error.to_string())?;

    Ok(SavedScreenshot {
        file_name: request.file_name,
        file_path: file_path.to_string_lossy().into_owned(),
    })
}

#[tauri::command]
fn save_recording(app: AppHandle, request: SaveRecordingRequest) -> CommandResult<SavedScreenshot> {
    let media_bytes = BASE64_STANDARD
        .decode(request.media_base64.as_bytes())
        .map_err(|error| error.to_string())?;

    let directory = resolve_capture_directory(&app, request.location, request.custom_directory.as_deref())?;
    fs::create_dir_all(&directory).map_err(|error| error.to_string())?;

    let file_path = directory.join(&request.file_name);
    fs::write(&file_path, media_bytes).map_err(|error| error.to_string())?;

    Ok(SavedScreenshot {
        file_name: request.file_name,
        file_path: file_path.to_string_lossy().into_owned(),
    })
}

#[tauri::command]
fn start_recording(app: AppHandle, state: State<'_, AppState>) -> CommandResult<SessionSnapshot> {
    let snapshot = {
        let mut guard = state.inner.lock().map_err(|error| error.to_string())?;

        if guard.snapshot.status == SessionStatus::Recording {
            return Ok(guard.snapshot.clone());
        }

        if guard.snapshot.status != SessionStatus::Mirroring {
            return Err(String::from("session is not ready to record"));
        }

        guard.snapshot.status = SessionStatus::Recording;
        guard.snapshot.clone()
    };

    emit_session_status(&app, &snapshot)?;
    Ok(snapshot)
}

#[tauri::command]
fn stop_recording(app: AppHandle, state: State<'_, AppState>) -> CommandResult<SessionSnapshot> {
    let snapshot = {
        let mut guard = state.inner.lock().map_err(|error| error.to_string())?;

        if guard.snapshot.status == SessionStatus::Idle {
            return Ok(guard.snapshot.clone());
        }

        if guard.snapshot.status != SessionStatus::Recording {
            return Err(String::from("recording is not active"));
        }

        guard.snapshot.status = SessionStatus::Mirroring;
        guard.snapshot.clone()
    };

    emit_session_status(&app, &snapshot)?;
    Ok(snapshot)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(AppState::default())
        .invoke_handler(tauri::generate_handler![
            get_session_snapshot,
            get_preview_telemetry,
            get_preview_stream_descriptor,
            get_preview_init_segment,
            take_preview_media_segment,
            get_remux_blueprint,
            get_receiver_sidecar_spec,
            get_receiver_runtime,
            get_preview_diagnostics,
            start_session,
            reconnect_session,
            stop_session,
            take_screenshot,
            save_screenshot,
            save_recording,
            start_recording,
            stop_recording
        ])
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
