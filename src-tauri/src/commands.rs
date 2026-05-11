use crate::models::{
    BonjourStatusSnapshot, CommandResult, PreviewDiagnosticsSnapshot, PreviewMediaSegmentPayload,
    PreviewStreamDescriptor, PreviewTelemetry, ReceiverRuntimeSnapshot, RemuxBlueprintSnapshot,
    SaveRecordingRequest, SaveScreenshotRequest, SavedScreenshot, SessionSnapshot, SessionStatus,
};
use crate::runtime::{
    bonjour_blocking_message, emit_preview_diagnostics, emit_receiver_runtime,
    emit_runtime_error, emit_session_status, emit_state_updates, ensure_bonjour_ready,
    ensure_sidecar_runtime, query_bonjour_status, resolve_capture_directory,
    send_sidecar_command, AppState,
};
use crate::sidecar::ReceiverSidecarSpec;
use crate::state::{
    clear_session_identity, prepare_live_transport, reset_fixture_transport, reset_preview,
    set_receiver_runtime_state, sync_preview_diagnostics,
};
use base64::prelude::{Engine as _, BASE64_STANDARD};
use serde_json::json;
use std::fs;
use std::process::Command;
use tauri::{AppHandle, State};

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
        let payload = guard.live_preview_buffer.take_next_segment().map(|segment| {
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
pub(crate) fn start_session(app: AppHandle, state: State<'_, AppState>) -> CommandResult<SessionSnapshot> {
    if let Err(error) = ensure_bonjour_ready() {
        emit_runtime_error(&app, &state.inner, error.clone(), false)?;
        return Err(error);
    }

    let sidecar_was_running = state.sidecar.lock().map_err(|error| error.to_string())?.is_some();

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
        let _ = send_sidecar_command(&state.sidecar, json!({
            "name": "stop_session",
            "session_id": session_id,
        }));
    }

    let sidecar_was_running = state.sidecar.lock().map_err(|error| error.to_string())?.is_some();

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
            set_receiver_runtime_state(&mut guard, crate::models::ReceiverRuntimeState::Ready);
        } else {
            guard.snapshot.status = SessionStatus::Discovering;
            set_receiver_runtime_state(&mut guard, crate::models::ReceiverRuntimeState::Priming);
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
pub(crate) fn stop_session(app: AppHandle, state: State<'_, AppState>) -> CommandResult<SessionSnapshot> {
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
        clear_session_identity(&mut guard);
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
pub(crate) fn take_screenshot(app: AppHandle, state: State<'_, AppState>) -> CommandResult<SessionSnapshot> {
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
pub(crate) fn save_screenshot(
    app: AppHandle,
    request: SaveScreenshotRequest,
) -> CommandResult<SavedScreenshot> {
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
pub(crate) fn save_recording(
    app: AppHandle,
    request: SaveRecordingRequest,
) -> CommandResult<SavedScreenshot> {
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
pub(crate) fn start_recording(app: AppHandle, state: State<'_, AppState>) -> CommandResult<SessionSnapshot> {
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
pub(crate) fn stop_recording(app: AppHandle, state: State<'_, AppState>) -> CommandResult<SessionSnapshot> {
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
    Err(String::from("Windows Services is only available on Windows."))
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