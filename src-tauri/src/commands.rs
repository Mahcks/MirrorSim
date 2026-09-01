use crate::history::{
    export_diagnostics_value, get_connection_history as get_saved_connection_history,
    now_unix_timestamp,
};
use crate::models::{
    AppUpdateInfo, BeginRecordingRequest, BonjourStatusSnapshot, CommandResult,
    ConnectionHistoryEntry, DiagnosticsExport, PairingEntryMode, PairingPhase, PairingSnapshot,
    PreviewDiagnosticsSnapshot, PreviewMediaSegmentPayload, PreviewStreamDescriptor,
    PreviewTelemetry, ReceiverRuntimeSnapshot, RecordingWriteSession, RemuxBlueprintSnapshot,
    SaveScreenshotRequest, SavedScreenshot, SessionSnapshot, SessionStatus, TrustedDevice,
};
use crate::runtime::{
    bonjour_blocking_message, emit_pairing_status, emit_preview_diagnostics, emit_receiver_runtime,
    emit_runtime_error, emit_session_status, emit_state_updates, ensure_bonjour_ready,
    ensure_sidecar_runtime, query_bonjour_status, resolve_capture_directory, send_sidecar_command,
    stop_sidecar_runtime, AppState, RecordingFileRuntime,
};
use crate::sidecar::ReceiverSidecarSpec;
use crate::state::{
    clear_pairing, clear_session_identity, prepare_live_transport, reset_fixture_transport,
    reset_preview, resume_local_session_approval, set_receiver_runtime_state,
    sync_preview_diagnostics,
};
use crate::trust::{
    apply_current_device_trust, forget_trusted_device as forget_trusted_device_from_registry,
    get_trusted_devices as get_trusted_devices_from_registry, note_known_device,
    rename_trusted_device as rename_trusted_device_in_registry,
    reset_trusted_devices as reset_trusted_devices_from_registry,
    set_trusted_device_blocked as set_trusted_device_blocked_in_registry, trust_device,
};
use crate::updater_config::{updater_is_configured, UPDATER_ENDPOINT};
use base64::prelude::{Engine as _, BASE64_STANDARD};
use serde_json::json;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Component, Path, PathBuf};
use std::process::Command;
use std::sync::atomic::Ordering;
use tauri::{AppHandle, State};
use tauri_plugin_updater::UpdaterExt;
use url::Url;

const KEYFRAME_REQUEST_CAPABILITY: &str = "keyframe-request";
const NATIVE_RECEIVER_CAPABILITY: &str = "native-receiver-process";
const MAX_SCREENSHOT_BYTES: usize = 64 * 1024 * 1024;
const MAX_RECORDING_CHUNK_BYTES: usize = 16 * 1024 * 1024;

fn validated_capture_path(
    directory: &Path,
    file_name: &str,
    expected_extension: &str,
) -> CommandResult<PathBuf> {
    let trimmed = file_name.trim();
    let path = Path::new(trimmed);
    let mut components = path.components();
    let is_single_normal_component =
        matches!(components.next(), Some(Component::Normal(_))) && components.next().is_none();
    let has_expected_extension = path
        .extension()
        .and_then(|value| value.to_str())
        .is_some_and(|value| value.eq_ignore_ascii_case(expected_extension));

    if trimmed.is_empty() || !is_single_normal_component || !has_expected_extension {
        return Err(format!(
            "capture filename must be a plain .{} filename",
            expected_extension
        ));
    }

    Ok(directory.join(path))
}

fn receiver_supports_keyframe_request(capabilities: &[String]) -> bool {
    capabilities.iter().any(|capability| {
        capability == KEYFRAME_REQUEST_CAPABILITY || capability == NATIVE_RECEIVER_CAPABILITY
    })
}

fn ensure_updater_is_configured() -> CommandResult<()> {
    if !updater_is_configured() {
        return Err(String::from("Updater is not configured for this build."));
    }

    Ok(())
}

fn pairing_device_policy(app: &AppHandle) -> CommandResult<(Vec<String>, Vec<String>)> {
    let devices = get_trusted_devices_from_registry(app)?;
    let trusted_device_ids = devices
        .iter()
        .filter(|device| device.trusted_at.is_some() && !device.is_blocked)
        .filter_map(|device| device.device_id.clone())
        .collect::<Vec<_>>();
    let blocked_device_ids = devices
        .iter()
        .filter(|device| device.is_blocked)
        .filter_map(|device| device.device_id.clone())
        .collect::<Vec<_>>();

    Ok((trusted_device_ids, blocked_device_ids))
}

fn stop_session_inner(
    app: &AppHandle,
    state: &State<'_, AppState>,
) -> CommandResult<SessionSnapshot> {
    let active_session_id = {
        let guard = state.inner.lock().map_err(|error| error.to_string())?;
        guard.active_session_id.clone()
    };

    if let Some(session_id) = active_session_id {
        let _ = send_sidecar_command(
            &state.sidecar,
            json!({
                "name": "stop_session",
                "session_id": session_id,
            }),
        );
    }

    let (snapshot, preview, preview_stream, receiver_runtime, preview_diagnostics) = {
        let mut guard = state.inner.lock().map_err(|error| error.to_string())?;
        guard.sequence += 1;
        guard.active_session_id = None;
        guard.require_local_session_approval = false;
        guard.require_known_device = false;
        guard.snapshot.status = SessionStatus::Idle;
        clear_session_identity(&mut guard);
        clear_pairing(&mut guard);
        reset_preview(&mut guard);
        reset_fixture_transport(&mut guard);
        set_receiver_runtime_state(&mut guard, crate::models::ReceiverRuntimeState::Idle);
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
        Some(snapshot.clone()),
        Some(preview),
        Some(preview_stream),
        Some(receiver_runtime),
        Some(preview_diagnostics),
    )?;

    Ok(snapshot)
}

#[tauri::command]
pub(crate) fn get_session_snapshot(state: State<'_, AppState>) -> CommandResult<SessionSnapshot> {
    let guard = state.inner.lock().map_err(|error| error.to_string())?;
    Ok(guard.snapshot.clone())
}

#[tauri::command]
pub(crate) fn get_preview_telemetry(state: State<'_, AppState>) -> CommandResult<PreviewTelemetry> {
    let guard = state.inner.lock().map_err(|error| error.to_string())?;
    Ok(guard.preview.clone())
}

#[tauri::command]
pub(crate) fn get_preview_stream_descriptor(
    state: State<'_, AppState>,
) -> CommandResult<PreviewStreamDescriptor> {
    let guard = state.inner.lock().map_err(|error| error.to_string())?;
    Ok(guard.preview_stream.clone())
}

#[tauri::command]
pub(crate) fn get_preview_init_segment(
    state: State<'_, AppState>,
) -> CommandResult<Option<Vec<u8>>> {
    let guard = state.inner.lock().map_err(|error| error.to_string())?;
    Ok(guard.live_preview_buffer.init_segment_bytes())
}

#[tauri::command]
pub(crate) fn take_preview_media_segment(
    app: AppHandle,
    state: State<'_, AppState>,
) -> CommandResult<Option<PreviewMediaSegmentPayload>> {
    let (payload, receiver_runtime, preview_diagnostics) = {
        let mut guard = state.inner.lock().map_err(|error| error.to_string())?;
        let payload = guard
            .live_preview_buffer
            .take_next_segment()
            .map(|segment| {
                guard.preview_diagnostics.delivered_segments += 1;
                guard.preview_diagnostics.last_delivered_sequence_number =
                    Some(segment.descriptor.sequence_number);
                guard.preview_diagnostics.last_delivered_first_sample_index =
                    Some(segment.descriptor.first_sample_index);
                guard.preview_diagnostics.last_delivered_last_sample_index =
                    Some(segment.descriptor.last_sample_index);

                PreviewMediaSegmentPayload {
                    sequence_number: segment.descriptor.sequence_number,
                    first_sample_index: segment.descriptor.first_sample_index,
                    last_sample_index: segment.descriptor.last_sample_index,
                    bytes: segment.bytes,
                }
            });
        guard.receiver_runtime.queued_segments = guard.live_preview_buffer.queued_segment_count();
        sync_preview_diagnostics(&mut guard);
        (
            payload,
            guard.receiver_runtime.clone(),
            guard.preview_diagnostics.clone(),
        )
    };

    emit_receiver_runtime(&app, &receiver_runtime)?;
    emit_preview_diagnostics(&app, &preview_diagnostics)?;
    Ok(payload)
}

#[tauri::command]
pub(crate) fn get_remux_blueprint(
    state: State<'_, AppState>,
) -> CommandResult<RemuxBlueprintSnapshot> {
    let guard = state.inner.lock().map_err(|error| error.to_string())?;
    Ok(RemuxBlueprintSnapshot {
        transport: guard.receiver_runtime.transport,
        blueprint: guard.remux_blueprint.clone(),
    })
}

#[tauri::command]
pub(crate) fn get_receiver_sidecar_spec() -> CommandResult<ReceiverSidecarSpec> {
    Ok(ReceiverSidecarSpec::direct_receiver_boundary())
}

#[tauri::command]
pub(crate) fn get_receiver_runtime(
    state: State<'_, AppState>,
) -> CommandResult<ReceiverRuntimeSnapshot> {
    let guard = state.inner.lock().map_err(|error| error.to_string())?;
    Ok(guard.receiver_runtime.clone())
}

#[tauri::command]
pub(crate) fn get_preview_diagnostics(
    state: State<'_, AppState>,
) -> CommandResult<PreviewDiagnosticsSnapshot> {
    let guard = state.inner.lock().map_err(|error| error.to_string())?;
    Ok(guard.preview_diagnostics.clone())
}

#[tauri::command]
pub(crate) async fn check_for_app_update(app: AppHandle) -> CommandResult<Option<AppUpdateInfo>> {
    ensure_updater_is_configured()?;
    let endpoint = Url::parse(UPDATER_ENDPOINT).map_err(|error| error.to_string())?;
    let update = app
        .updater_builder()
        .endpoints(vec![endpoint])
        .map_err(|error| error.to_string())?
        .build()
        .map_err(|error| error.to_string())?
        .check()
        .await
        .map_err(|error| error.to_string())?;

    Ok(update.map(|update| AppUpdateInfo {
        version: update.version,
        current_version: app.package_info().version.to_string(),
        notes: update.body,
        pub_date: update.date.map(|value| value.to_string()),
    }))
}

#[tauri::command]
pub(crate) async fn install_app_update(app: AppHandle) -> CommandResult<Option<AppUpdateInfo>> {
    ensure_updater_is_configured()?;
    let endpoint = Url::parse(UPDATER_ENDPOINT).map_err(|error| error.to_string())?;
    let update = app
        .updater_builder()
        .endpoints(vec![endpoint])
        .map_err(|error| error.to_string())?
        .build()
        .map_err(|error| error.to_string())?
        .check()
        .await
        .map_err(|error| error.to_string())?;

    let Some(update) = update else {
        return Ok(None);
    };

    let info = AppUpdateInfo {
        version: update.version.clone(),
        current_version: app.package_info().version.to_string(),
        notes: update.body.clone(),
        pub_date: update.date.map(|value| value.to_string()),
    };

    update
        .download_and_install(|_, _| {}, || {})
        .await
        .map_err(|error| error.to_string())?;

    Ok(Some(info))
}

#[tauri::command]
pub(crate) fn start_session(
    app: AppHandle,
    state: State<'_, AppState>,
    receiver_name: Option<String>,
    require_local_approval: Option<bool>,
    require_known_device: Option<bool>,
) -> CommandResult<SessionSnapshot> {
    if let Err(error) = ensure_bonjour_ready() {
        emit_runtime_error(&app, &state.inner, error.clone(), false)?;
        return Err(error);
    }

    let sidecar_was_running = state
        .sidecar
        .lock()
        .map_err(|error| error.to_string())?
        .is_some();
    let (trusted_device_ids, blocked_device_ids) = pairing_device_policy(&app)?;

    let (
        snapshot,
        preview,
        preview_stream,
        receiver_runtime,
        preview_diagnostics,
        session_id,
        stream_id,
        should_start,
    ) = {
        let mut guard = state.inner.lock().map_err(|error| error.to_string())?;

        let should_start = guard.snapshot.status == SessionStatus::Idle;

        let session_id = format!("session-{:04}", guard.sequence + 1);
        let stream_id = format!("airplay-stream-{:04}", guard.sequence + 1);

        if should_start {
            guard.sequence += 1;
            guard.active_session_id = Some(session_id.clone());
            guard.require_local_session_approval = require_local_approval.unwrap_or(false);
            guard.require_known_device = require_known_device.unwrap_or(false);
            guard.snapshot.status = SessionStatus::Discovering;
            clear_pairing(&mut guard);
            reset_preview(&mut guard);
            prepare_live_transport(&mut guard, stream_id.clone());
            set_receiver_runtime_state(&mut guard, crate::models::ReceiverRuntimeState::Priming);

            if sidecar_was_running {
                guard.snapshot.status = SessionStatus::Connecting;
                set_receiver_runtime_state(&mut guard, crate::models::ReceiverRuntimeState::Ready);
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
                "receiver_name": receiver_name,
                "trusted_device_ids": trusted_device_ids,
                "blocked_device_ids": blocked_device_ids,
            }),
        ) {
            emit_runtime_error(&app, &state.inner, error.clone(), false)?;
            return Err(error);
        }
    }

    Ok(snapshot)
}

#[tauri::command]
pub(crate) fn reconnect_session(
    app: AppHandle,
    state: State<'_, AppState>,
    receiver_name: Option<String>,
    require_local_approval: Option<bool>,
    require_known_device: Option<bool>,
) -> CommandResult<SessionSnapshot> {
    if let Err(error) = ensure_bonjour_ready() {
        emit_runtime_error(&app, &state.inner, error.clone(), false)?;
        return Err(error);
    }

    let active_session_id = {
        let guard = state.inner.lock().map_err(|error| error.to_string())?;
        guard.active_session_id.clone()
    };

    if let Some(session_id) = active_session_id {
        let _ = send_sidecar_command(
            &state.sidecar,
            json!({
                "name": "stop_session",
                "session_id": session_id,
            }),
        );
    }

    stop_sidecar_runtime(&state.sidecar);
    let (trusted_device_ids, blocked_device_ids) = pairing_device_policy(&app)?;

    let (
        snapshot,
        preview,
        preview_stream,
        receiver_runtime,
        preview_diagnostics,
        session_id,
        stream_id,
    ) = {
        let mut guard = state.inner.lock().map_err(|error| error.to_string())?;

        guard.sequence += 1;

        let session_id = format!("session-{:04}", guard.sequence);
        let stream_id = format!("airplay-stream-{:04}", guard.sequence);

        guard.active_session_id = Some(session_id.clone());
        guard.require_local_session_approval = require_local_approval.unwrap_or(false);
        guard.require_known_device = require_known_device.unwrap_or(false);
        clear_pairing(&mut guard);
        reset_preview(&mut guard);
        prepare_live_transport(&mut guard, stream_id.clone());

        guard.snapshot.status = SessionStatus::Discovering;
        set_receiver_runtime_state(&mut guard, crate::models::ReceiverRuntimeState::Priming);

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
            "receiver_name": receiver_name,
            "trusted_device_ids": trusted_device_ids,
            "blocked_device_ids": blocked_device_ids,
        }),
    ) {
        emit_runtime_error(&app, &state.inner, error.clone(), false)?;
        return Err(error);
    }

    Ok(snapshot)
}

#[tauri::command]
pub(crate) fn stop_session(
    app: AppHandle,
    state: State<'_, AppState>,
) -> CommandResult<SessionSnapshot> {
    stop_session_inner(&app, &state)
}

#[tauri::command]
pub(crate) fn take_screenshot(
    app: AppHandle,
    state: State<'_, AppState>,
) -> CommandResult<SessionSnapshot> {
    let snapshot = {
        let mut guard = state.inner.lock().map_err(|error| error.to_string())?;

        if !matches!(
            guard.snapshot.status,
            SessionStatus::Mirroring | SessionStatus::Recording
        ) {
            return Err(String::from("session is not ready for screenshots"));
        }

        guard.snapshot.capture_count += 1;
        guard.snapshot.clone()
    };

    emit_session_status(&app, &snapshot)?;
    Ok(snapshot)
}

#[tauri::command]
pub(crate) fn save_screenshot(
    app: AppHandle,
    request: SaveScreenshotRequest,
) -> CommandResult<SavedScreenshot> {
    if request.png_base64.len() > MAX_SCREENSHOT_BYTES * 2 {
        return Err(String::from("screenshot payload is too large"));
    }
    let png_bytes = BASE64_STANDARD
        .decode(request.png_base64.as_bytes())
        .map_err(|error| error.to_string())?;
    if png_bytes.len() > MAX_SCREENSHOT_BYTES || !png_bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        return Err(String::from("screenshot payload is not a valid-sized PNG"));
    }

    let directory =
        resolve_capture_directory(&app, request.location, request.custom_directory.as_deref())?;
    fs::create_dir_all(&directory).map_err(|error| error.to_string())?;

    let file_path = validated_capture_path(&directory, &request.file_name, "png")?;
    eprintln!(
        "[MirrorSim capture] saving screenshot to {}",
        file_path.display()
    );
    fs::write(&file_path, png_bytes).map_err(|error| error.to_string())?;

    Ok(SavedScreenshot {
        file_name: request.file_name,
        file_path: file_path.to_string_lossy().into_owned(),
    })
}

#[tauri::command]
pub(crate) fn begin_recording_save(
    app: AppHandle,
    state: State<'_, AppState>,
    request: BeginRecordingRequest,
) -> CommandResult<RecordingWriteSession> {
    let directory =
        resolve_capture_directory(&app, request.location, request.custom_directory.as_deref())?;
    fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
    let final_path = validated_capture_path(&directory, &request.file_name, "webm")?;
    let temporary_path = final_path.with_extension("webm.part");
    let mut guard = state
        .recording_file
        .lock()
        .map_err(|error| error.to_string())?;
    if guard.is_some() {
        return Err(String::from("a recording file is already open"));
    }

    let file = OpenOptions::new()
        .create(true)
        .truncate(true)
        .write(true)
        .open(&temporary_path)
        .map_err(|error| error.to_string())?;
    let recording_id = state.next_recording_id.fetch_add(1, Ordering::Relaxed);
    *guard = Some(RecordingFileRuntime {
        recording_id,
        file_name: request.file_name.clone(),
        final_path: final_path.clone(),
        temporary_path,
        file,
        bytes_written: 0,
    });

    Ok(RecordingWriteSession {
        recording_id,
        file_name: request.file_name,
        file_path: final_path.to_string_lossy().into_owned(),
    })
}

#[tauri::command]
pub(crate) fn append_recording_chunk(
    state: State<'_, AppState>,
    recording_id: u64,
    chunk_base64: String,
) -> CommandResult<()> {
    if chunk_base64.len() > MAX_RECORDING_CHUNK_BYTES * 2 {
        return Err(String::from("recording chunk is too large"));
    }
    let bytes = BASE64_STANDARD
        .decode(chunk_base64.as_bytes())
        .map_err(|error| error.to_string())?;
    if bytes.len() > MAX_RECORDING_CHUNK_BYTES {
        return Err(String::from("recording chunk is too large"));
    }

    let mut guard = state
        .recording_file
        .lock()
        .map_err(|error| error.to_string())?;
    let recording = guard
        .as_mut()
        .filter(|recording| recording.recording_id == recording_id)
        .ok_or_else(|| String::from("recording file is not active"))?;
    if recording.bytes_written == 0 && !bytes.starts_with(&[0x1A, 0x45, 0xDF, 0xA3]) {
        return Err(String::from("recording stream is missing its WebM header"));
    }
    recording
        .file
        .write_all(&bytes)
        .map_err(|error| error.to_string())?;
    recording.bytes_written = recording.bytes_written.saturating_add(bytes.len() as u64);
    Ok(())
}

#[tauri::command]
pub(crate) fn finish_recording_save(
    state: State<'_, AppState>,
    recording_id: u64,
) -> CommandResult<SavedScreenshot> {
    let recording = {
        let mut guard = state
            .recording_file
            .lock()
            .map_err(|error| error.to_string())?;
        if guard.as_ref().map(|value| value.recording_id) != Some(recording_id) {
            return Err(String::from("recording file is not active"));
        }
        if guard.as_ref().map(|value| value.bytes_written) == Some(0) {
            return Err(String::from("recording did not produce any media data"));
        }
        guard
            .take()
            .ok_or_else(|| String::from("recording file is not active"))?
    };

    let RecordingFileRuntime {
        file_name,
        final_path,
        temporary_path,
        file,
        ..
    } = recording;
    file.sync_all().map_err(|error| error.to_string())?;
    drop(file);
    if final_path.exists() {
        fs::remove_file(&final_path).map_err(|error| error.to_string())?;
    }
    fs::rename(&temporary_path, &final_path).map_err(|error| error.to_string())?;

    Ok(SavedScreenshot {
        file_name,
        file_path: final_path.to_string_lossy().into_owned(),
    })
}

#[tauri::command]
pub(crate) fn abort_recording_save(
    state: State<'_, AppState>,
    recording_id: u64,
) -> CommandResult<()> {
    let recording = {
        let mut guard = state
            .recording_file
            .lock()
            .map_err(|error| error.to_string())?;
        if guard.as_ref().map(|value| value.recording_id) != Some(recording_id) {
            return Ok(());
        }
        guard.take()
    };

    if let Some(recording) = recording {
        drop(recording.file);
        if recording.temporary_path.exists() {
            fs::remove_file(recording.temporary_path).map_err(|error| error.to_string())?;
        }
    }
    Ok(())
}

#[tauri::command]
pub(crate) fn start_recording(
    app: AppHandle,
    state: State<'_, AppState>,
) -> CommandResult<SessionSnapshot> {
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
pub(crate) fn stop_recording(
    app: AppHandle,
    state: State<'_, AppState>,
) -> CommandResult<SessionSnapshot> {
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

#[tauri::command]
pub(crate) fn get_bonjour_status() -> BonjourStatusSnapshot {
    query_bonjour_status()
}

#[tauri::command]
pub(crate) fn get_pairing_snapshot(state: State<'_, AppState>) -> CommandResult<PairingSnapshot> {
    let guard = state.inner.lock().map_err(|error| error.to_string())?;
    Ok(guard.pairing.clone())
}

#[tauri::command]
pub(crate) fn get_trusted_devices(app: AppHandle) -> CommandResult<Vec<TrustedDevice>> {
    get_trusted_devices_from_registry(&app)
}

#[tauri::command]
pub(crate) fn get_connection_history(app: AppHandle) -> CommandResult<Vec<ConnectionHistoryEntry>> {
    get_saved_connection_history(&app)
}

#[tauri::command]
pub(crate) fn trust_current_device(
    app: AppHandle,
    state: State<'_, AppState>,
) -> CommandResult<Vec<TrustedDevice>> {
    let (
        device_name,
        device_id,
        device_model,
        device_os_name,
        device_os_version,
        device_os_build_version,
        device_source_version,
    ) = {
        let guard = state.inner.lock().map_err(|error| error.to_string())?;
        if matches!(
            guard.snapshot.status,
            SessionStatus::Idle | SessionStatus::Discovering
        ) {
            return Err(String::from("connect an iPhone first before trusting it"));
        }
        (
            guard.snapshot.device_name.clone(),
            guard.snapshot.current_device_id.clone(),
            guard.snapshot.current_device_model.clone(),
            guard.snapshot.current_device_os_name.clone(),
            guard.snapshot.current_device_os_version.clone(),
            guard.snapshot.current_device_os_build_version.clone(),
            guard.snapshot.current_device_source_version.clone(),
        )
    };

    let trusted_devices = trust_device(
        &app,
        &device_name,
        device_id.as_deref(),
        device_model.as_deref(),
        device_os_name.as_deref(),
        device_os_version.as_deref(),
        device_os_build_version.as_deref(),
        device_source_version.as_deref(),
    )?;

    let snapshot = {
        let mut guard = state.inner.lock().map_err(|error| error.to_string())?;
        apply_current_device_trust(&mut guard.snapshot, &trusted_devices);
        guard.snapshot.clone()
    };

    emit_session_status(&app, &snapshot)?;
    Ok(trusted_devices)
}

#[tauri::command]
pub(crate) fn confirm_pairing_trust(
    app: AppHandle,
    state: State<'_, AppState>,
    remember_device: Option<bool>,
) -> CommandResult<PairingSnapshot> {
    let remember_device = remember_device.unwrap_or(true);

    let local_resume_state = {
        let mut guard = state.inner.lock().map_err(|error| error.to_string())?;
        if guard.pending_local_session_approval {
            if !guard.snapshot.device_name.is_empty() {
                let trusted_devices = if remember_device {
                    trust_device(
                        &app,
                        &guard.snapshot.device_name,
                        guard.snapshot.current_device_id.as_deref(),
                        guard.snapshot.current_device_model.as_deref(),
                        guard.snapshot.current_device_os_name.as_deref(),
                        guard.snapshot.current_device_os_version.as_deref(),
                        guard.snapshot.current_device_os_build_version.as_deref(),
                        guard.snapshot.current_device_source_version.as_deref(),
                    )?
                } else {
                    note_known_device(
                        &app,
                        &guard.snapshot.device_name,
                        guard.snapshot.current_device_id.as_deref(),
                        guard.snapshot.current_device_model.as_deref(),
                        guard.snapshot.current_device_os_name.as_deref(),
                        guard.snapshot.current_device_os_version.as_deref(),
                        guard.snapshot.current_device_os_build_version.as_deref(),
                        guard.snapshot.current_device_source_version.as_deref(),
                    )?
                };
                apply_current_device_trust(&mut guard.snapshot, &trusted_devices);
            }

            let should_confirm_sidecar = guard
                .snapshot
                .receiver_capabilities
                .iter()
                .any(|capability| capability == "pairing-trust-control");
            let should_request_keyframe =
                receiver_supports_keyframe_request(&guard.snapshot.receiver_capabilities);
            let session_id = guard.active_session_id.clone();
            let stream_id = guard.receiver_runtime.stream_id.clone();

            resume_local_session_approval(&mut guard);
            Some((
                guard.pairing.clone(),
                guard.snapshot.clone(),
                guard.receiver_runtime.clone(),
                guard.preview_diagnostics.clone(),
                session_id,
                stream_id,
                should_confirm_sidecar,
                should_request_keyframe,
            ))
        } else {
            None
        }
    };

    if let Some((
        pairing,
        snapshot,
        receiver_runtime,
        preview_diagnostics,
        session_id,
        stream_id,
        should_confirm_sidecar,
        should_request_keyframe,
    )) = local_resume_state
    {
        emit_pairing_status(&app, &pairing)?;
        emit_state_updates(
            &app,
            Some(snapshot),
            None,
            None,
            Some(receiver_runtime),
            Some(preview_diagnostics),
        )?;

        if should_confirm_sidecar {
            let _ = send_sidecar_command(
                &state.sidecar,
                json!({
                    "name": "confirm_pairing_trust",
                    "session_id": session_id,
                    "remember_device": remember_device,
                }),
            );
        }

        if should_request_keyframe {
            let _ = send_sidecar_command(
                &state.sidecar,
                json!({
                    "name": "request_keyframe",
                    "stream_id": stream_id,
                    "reason": "local_session_approved",
                }),
            );
        }

        return Ok(pairing);
    }

    {
        let guard = state.inner.lock().map_err(|error| error.to_string())?;
        if !guard
            .snapshot
            .receiver_capabilities
            .iter()
            .any(|capability| capability == "pairing-trust-control")
        {
            return Err(String::from(
                "this receiver build cannot confirm AirPlay trust from MirrorSim yet",
            ));
        }
    }

    let (pairing, session_id) = {
        let mut guard = state.inner.lock().map_err(|error| error.to_string())?;
        if !guard.pairing.can_trust {
            return Err(String::from(
                "there is no trust confirmation waiting right now",
            ));
        }

        guard.remember_pairing_approval = remember_device;

        guard.pairing.phase = PairingPhase::Verifying;
        guard.pairing.entry_mode = PairingEntryMode::ConfirmOnly;
        guard.pairing.failure_message = None;

        (guard.pairing.clone(), guard.active_session_id.clone())
    };

    emit_pairing_status(&app, &pairing)?;

    send_sidecar_command(
        &state.sidecar,
        json!({
            "name": "confirm_pairing_trust",
            "session_id": session_id,
            "remember_device": remember_device,
        }),
    )?;

    Ok(pairing)
}

#[tauri::command]
pub(crate) fn cancel_pairing(
    app: AppHandle,
    state: State<'_, AppState>,
) -> CommandResult<PairingSnapshot> {
    {
        let guard = state.inner.lock().map_err(|error| error.to_string())?;
        if guard.pending_local_session_approval {
            drop(guard);
            let _ = stop_session_inner(&app, &state)?;
            let guard = state.inner.lock().map_err(|error| error.to_string())?;
            return Ok(guard.pairing.clone());
        }
    }

    let (pairing, session_id) = {
        let mut guard = state.inner.lock().map_err(|error| error.to_string())?;
        clear_pairing(&mut guard);
        (guard.pairing.clone(), guard.active_session_id.clone())
    };

    emit_pairing_status(&app, &pairing)?;

    send_sidecar_command(
        &state.sidecar,
        json!({
            "name": "cancel_pairing",
            "session_id": session_id,
        }),
    )?;

    Ok(pairing)
}

#[tauri::command]
pub(crate) fn forget_trusted_device(
    app: AppHandle,
    state: State<'_, AppState>,
    device_key: String,
) -> CommandResult<Vec<TrustedDevice>> {
    let trusted_devices = forget_trusted_device_from_registry(&app, &device_key)?;

    let snapshot = {
        let mut guard = state.inner.lock().map_err(|error| error.to_string())?;
        apply_current_device_trust(&mut guard.snapshot, &trusted_devices);
        guard.snapshot.clone()
    };

    emit_session_status(&app, &snapshot)?;
    Ok(trusted_devices)
}

#[tauri::command]
pub(crate) fn rename_trusted_device(
    app: AppHandle,
    state: State<'_, AppState>,
    device_key: String,
    nickname: Option<String>,
) -> CommandResult<Vec<TrustedDevice>> {
    let trusted_devices =
        rename_trusted_device_in_registry(&app, &device_key, nickname.as_deref())?;

    let snapshot = {
        let mut guard = state.inner.lock().map_err(|error| error.to_string())?;
        apply_current_device_trust(&mut guard.snapshot, &trusted_devices);
        guard.snapshot.clone()
    };

    emit_session_status(&app, &snapshot)?;
    Ok(trusted_devices)
}

#[tauri::command]
pub(crate) fn set_trusted_device_blocked(
    app: AppHandle,
    state: State<'_, AppState>,
    device_key: String,
    blocked: bool,
    reason: Option<String>,
) -> CommandResult<Vec<TrustedDevice>> {
    let trusted_devices =
        set_trusted_device_blocked_in_registry(&app, &device_key, blocked, reason.as_deref())?;

    let snapshot = {
        let mut guard = state.inner.lock().map_err(|error| error.to_string())?;
        apply_current_device_trust(&mut guard.snapshot, &trusted_devices);
        guard.snapshot.clone()
    };

    emit_session_status(&app, &snapshot)?;
    Ok(trusted_devices)
}

#[tauri::command]
pub(crate) fn reset_trusted_devices(
    app: AppHandle,
    state: State<'_, AppState>,
) -> CommandResult<Vec<TrustedDevice>> {
    let trusted_devices = reset_trusted_devices_from_registry(&app)?;

    let snapshot = {
        let mut guard = state.inner.lock().map_err(|error| error.to_string())?;
        apply_current_device_trust(&mut guard.snapshot, &trusted_devices);
        guard.snapshot.clone()
    };

    emit_session_status(&app, &snapshot)?;
    Ok(trusted_devices)
}

#[tauri::command]
pub(crate) fn open_windows_services() -> CommandResult<()> {
    #[cfg(windows)]
    {
        Command::new("cmd")
            .args(["/C", "start", "", "services.msc"])
            .spawn()
            .map_err(|error| error.to_string())?;
        return Ok(());
    }

    #[allow(unreachable_code)]
    Err(String::from(
        "Windows Services is only available on Windows.",
    ))
}

#[tauri::command]
pub(crate) fn open_windows_firewall() -> CommandResult<()> {
    #[cfg(windows)]
    {
        Command::new("cmd")
            .args([
                "/C",
                "start",
                "",
                "control.exe",
                "/name",
                "Microsoft.WindowsFirewall",
            ])
            .spawn()
            .map_err(|error| error.to_string())?;
        return Ok(());
    }

    #[allow(unreachable_code)]
    Err(String::from(
        "Windows Firewall is only available on Windows.",
    ))
}

#[tauri::command]
pub(crate) fn export_diagnostics_report(
    app: AppHandle,
    state: State<'_, AppState>,
    receiver_name: Option<String>,
) -> CommandResult<DiagnosticsExport> {
    let history = get_saved_connection_history(&app)?;
    let trusted_devices = get_trusted_devices_from_registry(&app)?;
    let bonjour = query_bonjour_status();
    let (session, pairing, receiver_runtime, preview_diagnostics) = {
        let guard = state.inner.lock().map_err(|error| error.to_string())?;
        (
            guard.snapshot.clone(),
            guard.pairing.clone(),
            guard.receiver_runtime.clone(),
            guard.preview_diagnostics.clone(),
        )
    };

    let report = json!({
        "exportedAt": now_unix_timestamp(),
        "receiverName": receiver_name,
        "bonjour": bonjour,
        "session": session,
        "pairing": pairing,
        "receiverRuntime": receiver_runtime,
        "previewDiagnostics": preview_diagnostics,
        "trustedDevices": trusted_devices,
        "history": history,
    });

    export_diagnostics_value(&app, &report)
}

#[tauri::command]
pub(crate) fn refresh_receiver_readiness(
    app: AppHandle,
    state: State<'_, AppState>,
) -> CommandResult<ReceiverRuntimeSnapshot> {
    let bonjour = query_bonjour_status();

    let receiver_runtime = {
        let mut guard = state.inner.lock().map_err(|error| error.to_string())?;
        if matches!(guard.snapshot.status, SessionStatus::Idle) {
            guard.receiver_runtime.last_error = bonjour_blocking_message(&bonjour);
        }
        guard.receiver_runtime.clone()
    };

    emit_receiver_runtime(&app, &receiver_runtime)?;
    Ok(receiver_runtime)
}

#[cfg(test)]
mod tests {
    use super::validated_capture_path;
    use std::path::Path;

    #[test]
    fn capture_path_accepts_a_plain_expected_filename() {
        let result = validated_capture_path(Path::new("C:/captures"), "shot.PNG", "png")
            .expect("plain PNG filename");
        assert_eq!(result, Path::new("C:/captures").join("shot.PNG"));
    }

    #[test]
    fn capture_path_rejects_traversal_absolute_and_wrong_extension() {
        for filename in ["../shot.png", "nested/shot.png", "C:/shot.png", "shot.exe"] {
            assert!(validated_capture_path(Path::new("C:/captures"), filename, "png").is_err());
        }
    }
}
