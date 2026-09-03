use crate::history::{
    export_diagnostics_value, get_connection_history as get_saved_connection_history,
    now_unix_timestamp,
};
use crate::models::{
    AppUpdateInfo, BeginRecordingRequest, BonjourStatusSnapshot, CommandResult,
    ConnectionHistoryEntry, DiagnosticsExport, PairingEntryMode, PairingPhase, PairingSnapshot,
    PreviewAudioFramePayload, PreviewDiagnosticsSnapshot, PreviewStreamDescriptor,
    PreviewTelemetry, ReceiverRuntimeSnapshot, RecordingWriteSession, RemuxBlueprintSnapshot,
    SaveScreenshotRequest, SavedScreenshot, SessionSnapshot, SessionStatus, TrustedDevice,
};
use crate::runtime::{
    bonjour_blocking_message, emit_pairing_status, emit_preview_diagnostics, emit_receiver_runtime,
    emit_runtime_error, emit_session_status, emit_state_updates, ensure_bonjour_ready,
    ensure_sidecar_runtime, query_bonjour_status, resolve_capture_directory, send_sidecar_command,
    stop_sidecar_runtime, AppState, PendingAppUpdate, RecordingFileRuntime,
};
use crate::sidecar::ReceiverSidecarSpec;
use crate::state::{
    clear_current_device_identity, clear_pairing, prepare_live_transport, reset_fixture_transport,
    reset_preview, resume_local_session_approval, set_receiver_runtime_state,
    sync_preview_diagnostics, SessionStore,
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
use serde_json::{json, Value};
use std::fs::{self, OpenOptions};
use std::io::{ErrorKind, Write};
use std::path::{Component, Path, PathBuf};
use std::process::Command;
use std::sync::atomic::Ordering;
use tauri::{ipc::Response, AppHandle, State};
use tauri_plugin_updater::UpdaterExt;
use url::Url;

#[cfg(windows)]
use std::os::windows::ffi::OsStrExt;
#[cfg(windows)]
use windows_sys::Win32::Storage::FileSystem::{MoveFileExW, MOVEFILE_WRITE_THROUGH};

const KEYFRAME_REQUEST_CAPABILITY: &str = "keyframe-request";
const MAX_SCREENSHOT_BYTES: usize = 64 * 1024 * 1024;
const MAX_RECORDING_CHUNK_BYTES: usize = 16 * 1024 * 1024;
const MAX_CAPTURE_NAME_ATTEMPTS: usize = 10_000;
// sequence number + first/last sample + flags + decode time + duration.
// Keep this in sync with PREVIEW_SEGMENT_HEADER_BYTES in mockPreviewStream.ts.
const PREVIEW_SEGMENT_HEADER_BYTES: usize = 25;
// sample index + flags + decode timestamp + duration. Keep this in sync with
// PREVIEW_ACCESS_UNIT_HEADER_BYTES in mockPreviewStream.ts.
const PREVIEW_ACCESS_UNIT_HEADER_BYTES: usize = 17;
const PREVIEW_ACCESS_UNIT_NEEDS_RANDOM_ACCESS: u8 = 2;
const PREVIEW_ACCESS_UNIT_CLIENT_INVALIDATED: u8 = 4;
const MAX_RETAINED_CLIENT_DIAGNOSTIC_CHARS: usize = 4_000;

fn diagnostic_key_is_sensitive(key: &str) -> bool {
    matches!(
        key.chars()
            .filter(|character| character.is_ascii_alphanumeric())
            .flat_map(char::to_lowercase)
            .collect::<String>()
            .as_str(),
        "key"
            | "deviceid"
            | "devicekey"
            | "currentdeviceid"
            | "currentdevicekey"
            | "sessionid"
            | "challengeid"
    )
}

fn collect_diagnostic_secrets(value: &Value, secrets: &mut Vec<String>) {
    match value {
        Value::Object(object) => {
            for (key, child) in object {
                if diagnostic_key_is_sensitive(key) {
                    if let Some(secret) = child.as_str().filter(|secret| secret.len() >= 4) {
                        if !secrets.iter().any(|existing| existing == secret) {
                            secrets.push(secret.to_string());
                        }
                    }
                } else {
                    collect_diagnostic_secrets(child, secrets);
                }
            }
        }
        Value::Array(values) => {
            for child in values {
                collect_diagnostic_secrets(child, secrets);
            }
        }
        _ => {}
    }
}

fn redact_diagnostics(value: &mut Value) {
    let mut secrets = Vec::new();
    collect_diagnostic_secrets(value, &mut secrets);
    secrets.sort_by_key(|secret| std::cmp::Reverse(secret.len()));

    fn redact_hex_fingerprints(text: &str) -> String {
        let characters = text.chars().collect::<Vec<_>>();
        let mut redacted = String::with_capacity(text.len());
        let mut index = 0;
        while index < characters.len() {
            if characters[index].is_ascii_hexdigit() {
                let start = index;
                let mut hex_digits = 0;
                while index < characters.len()
                    && (characters[index].is_ascii_hexdigit()
                        || matches!(characters[index], ':' | '-'))
                {
                    if characters[index].is_ascii_hexdigit() {
                        hex_digits += 1;
                    }
                    index += 1;
                }
                if hex_digits >= 12 {
                    redacted.push_str("[redacted-fingerprint]");
                } else {
                    redacted.extend(&characters[start..index]);
                }
            } else {
                redacted.push(characters[index]);
                index += 1;
            }
        }
        redacted
    }

    fn redact(value: &mut Value, secrets: &[String]) {
        match value {
            Value::Object(object) => {
                for (key, child) in object {
                    if diagnostic_key_is_sensitive(key) && !child.is_null() {
                        *child = Value::String(String::from("[redacted]"));
                    } else {
                        redact(child, secrets);
                    }
                }
            }
            Value::Array(values) => {
                for child in values {
                    redact(child, secrets);
                }
            }
            Value::String(text) => {
                for secret in secrets {
                    if text.contains(secret) {
                        *text = text.replace(secret, "[redacted]");
                    }
                }
                *text = redact_hex_fingerprints(text);
            }
            _ => {}
        }
    }

    redact(value, &secrets);
}

struct PairingConfirmationTransition {
    session_id: String,
    challenge_id: String,
    previous_pairing: PairingSnapshot,
    previous_native_pairing_approved: bool,
    previous_remember_pairing_approval: bool,
}

fn begin_pairing_confirmation(
    store: &mut SessionStore,
    remember_device: bool,
) -> CommandResult<PairingConfirmationTransition> {
    if !store.pairing.can_trust {
        return Err(String::from(
            "there is no trust confirmation waiting right now",
        ));
    }

    let session_id = store
        .pairing
        .session_id
        .as_deref()
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| String::from("pairing request is missing its session identity"))?
        .to_string();
    let challenge_id = store
        .pairing
        .challenge_id
        .as_deref()
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| String::from("pairing request is missing its challenge identity"))?
        .to_string();

    if store.active_session_id.as_deref() != Some(session_id.as_str()) {
        return Err(String::from(
            "pairing request does not belong to the active receiver session",
        ));
    }

    let transition = PairingConfirmationTransition {
        session_id,
        challenge_id,
        previous_pairing: store.pairing.clone(),
        previous_native_pairing_approved: store.native_pairing_approved_for_session,
        previous_remember_pairing_approval: store.remember_pairing_approval,
    };

    // The native adapter emits session_started immediately before its final
    // paired event. Remember this decision now so SessionStarted does not
    // display a second approval prompt or erase the remember choice.
    store.native_pairing_approved_for_session = true;
    store.remember_pairing_approval = remember_device;
    store.pairing.phase = PairingPhase::Verifying;
    store.pairing.entry_mode = PairingEntryMode::ConfirmOnly;
    store.pairing.failure_message = None;

    Ok(transition)
}

fn rollback_pairing_confirmation(
    store: &mut SessionStore,
    transition: &PairingConfirmationTransition,
) {
    let transition_is_still_current = store.pairing.phase == PairingPhase::Verifying
        && store.pairing.session_id.as_deref() == Some(transition.session_id.as_str())
        && store.pairing.challenge_id.as_deref() == Some(transition.challenge_id.as_str());

    if transition_is_still_current {
        store.pairing = transition.previous_pairing.clone();
        store.native_pairing_approved_for_session = transition.previous_native_pairing_approved;
        store.remember_pairing_approval = transition.previous_remember_pairing_approval;
    }
}

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
            "capture filename must be a plain .{expected_extension} filename"
        ));
    }

    Ok(directory.join(path))
}

fn capture_path_candidate(path: &Path, attempt: usize) -> CommandResult<PathBuf> {
    if attempt == 1 {
        return Ok(path.to_path_buf());
    }

    let stem = path
        .file_stem()
        .and_then(|value| value.to_str())
        .ok_or_else(|| String::from("capture filename is not valid Unicode"))?;
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .ok_or_else(|| String::from("capture filename is missing an extension"))?;
    let file_name = format!("{stem} ({attempt}).{extension}");
    Ok(path.with_file_name(file_name))
}

fn create_unique_capture_file(path: &Path) -> CommandResult<(fs::File, PathBuf)> {
    for attempt in 1..=MAX_CAPTURE_NAME_ATTEMPTS {
        let candidate = capture_path_candidate(path, attempt)?;
        match OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&candidate)
        {
            Ok(file) => return Ok((file, candidate)),
            Err(error) if error.kind() == ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(error.to_string()),
        }
    }

    Err(String::from(
        "could not allocate a unique capture filename after 10,000 attempts",
    ))
}

fn create_unique_recording_temp_file(
    directory: &Path,
    recording_id: u64,
) -> CommandResult<(fs::File, PathBuf)> {
    for attempt in 1..=MAX_CAPTURE_NAME_ATTEMPTS {
        let file_name = format!(
            ".mirrorsim-recording-{}-{recording_id}-{attempt}.webm.part",
            std::process::id()
        );
        let temporary_path = directory.join(file_name);
        match OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&temporary_path)
        {
            Ok(file) => return Ok((file, temporary_path)),
            Err(error) if error.kind() == ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(error.to_string()),
        }
    }

    Err(String::from(
        "could not allocate a unique recording workspace after 10,000 attempts",
    ))
}

fn persist_recording_without_overwrite(
    temporary_path: &Path,
    requested_path: &Path,
) -> CommandResult<PathBuf> {
    for attempt in 1..=MAX_CAPTURE_NAME_ATTEMPTS {
        let candidate = capture_path_candidate(requested_path, attempt)?;
        match move_file_without_overwrite(temporary_path, &candidate) {
            Ok(()) => {
                return Ok(candidate);
            }
            Err(error) if error.kind() == ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(error.to_string()),
        }
    }

    Err(String::from(
        "could not allocate a unique recording filename after 10,000 attempts",
    ))
}

#[cfg(windows)]
fn move_file_without_overwrite(source: &Path, destination: &Path) -> std::io::Result<()> {
    let wide = |path: &Path| {
        path.as_os_str()
            .encode_wide()
            .chain(std::iter::once(0))
            .collect::<Vec<_>>()
    };
    let source_wide = wide(source);
    let destination_wide = wide(destination);
    let moved = unsafe {
        MoveFileExW(
            source_wide.as_ptr(),
            destination_wide.as_ptr(),
            MOVEFILE_WRITE_THROUGH,
        )
    };
    if moved == 0 {
        Err(std::io::Error::last_os_error())
    } else {
        Ok(())
    }
}

#[cfg(not(windows))]
fn move_file_without_overwrite(source: &Path, destination: &Path) -> std::io::Result<()> {
    let mut source_file = fs::File::open(source)?;
    let mut destination_file = OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(destination)?;
    let result = std::io::copy(&mut source_file, &mut destination_file)
        .and_then(|_| destination_file.sync_all());
    drop(destination_file);
    if let Err(error) = result {
        let _ = fs::remove_file(destination);
        return Err(error);
    }
    if let Err(error) = fs::remove_file(source) {
        let _ = fs::remove_file(destination);
        return Err(error);
    }
    Ok(())
}

fn receiver_supports_keyframe_request(capabilities: &[String]) -> bool {
    capabilities
        .iter()
        .any(|capability| capability == KEYFRAME_REQUEST_CAPABILITY)
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

fn mark_session_stopped(store: &mut SessionStore) {
    store.sequence += 1;
    store.active_session_id = None;
    store.require_local_session_approval = false;
    store.require_known_device = false;
    store.native_pairing_approved_for_session = false;
    store.snapshot.status = SessionStatus::Idle;
    // The receiver process stays alive between listening sessions, so retain
    // its identity and capabilities. Only the disconnected sender is cleared.
    clear_current_device_identity(store);
    clear_pairing(store);
    reset_preview(store);
    reset_fixture_transport(store);
    set_receiver_runtime_state(store, crate::models::ReceiverRuntimeState::Idle);
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
        mark_session_stopped(&mut guard);
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
pub(crate) fn prepare_preview_media_stream(
    app: AppHandle,
    state: State<'_, AppState>,
) -> CommandResult<u64> {
    let (client_generation, receiver_runtime, preview_diagnostics) = {
        let mut guard = state.inner.lock().map_err(|error| error.to_string())?;
        let (client_generation, _queued) = guard.live_preview_buffer.prepare_client_stream();
        guard.receiver_runtime.queued_segments = guard.live_preview_buffer.queued_segment_count();
        sync_preview_diagnostics(&mut guard);
        (
            client_generation,
            guard.receiver_runtime.clone(),
            guard.preview_diagnostics.clone(),
        )
    };

    emit_receiver_runtime(&app, &receiver_runtime)?;
    emit_preview_diagnostics(&app, &preview_diagnostics)?;
    Ok(client_generation)
}

#[tauri::command]
pub(crate) fn prepare_preview_decoder_stream(state: State<'_, AppState>) -> CommandResult<Value> {
    let mut guard = state.inner.lock().map_err(|error| error.to_string())?;
    let (client_generation, queued_access_units, needs_random_access) =
        guard.live_preview_buffer.prepare_decoder_stream();
    Ok(json!({
        "clientGeneration": client_generation,
        "queuedAccessUnits": queued_access_units,
        "needsRandomAccess": needs_random_access,
    }))
}

#[tauri::command]
pub(crate) fn take_preview_video_access_unit(
    client_generation: u64,
    state: State<'_, AppState>,
) -> CommandResult<Response> {
    let mut guard = state.inner.lock().map_err(|error| error.to_string())?;
    let client_is_current = guard
        .live_preview_buffer
        .decoder_client_is_current(client_generation);
    let access_unit = client_is_current
        .then(|| {
            guard
                .live_preview_buffer
                .take_next_decoder_access_unit_for_client(client_generation)
        })
        .flatten();
    let random_access_lost =
        client_is_current && guard.live_preview_buffer.decoder_random_access_lost();
    let payload = access_unit
        .map(|access_unit| {
            let mut payload =
                Vec::with_capacity(PREVIEW_ACCESS_UNIT_HEADER_BYTES + access_unit.bytes.len());
            payload.extend_from_slice(&access_unit.sequence_number.to_le_bytes());
            payload.push(u8::from(access_unit.descriptor.is_keyframe));
            payload
                .extend_from_slice(&access_unit.descriptor.timing.decode_timestamp.to_le_bytes());
            payload.extend_from_slice(&access_unit.descriptor.timing.duration.to_le_bytes());
            payload.extend_from_slice(&access_unit.bytes);
            payload
        })
        .unwrap_or_else(|| {
            if !client_is_current {
                let mut payload = vec![0; PREVIEW_ACCESS_UNIT_HEADER_BYTES];
                payload[4] = PREVIEW_ACCESS_UNIT_CLIENT_INVALIDATED;
                return payload;
            }
            if !random_access_lost {
                return Vec::new();
            }
            let mut payload = vec![0; PREVIEW_ACCESS_UNIT_HEADER_BYTES];
            payload[4] = PREVIEW_ACCESS_UNIT_NEEDS_RANDOM_ACCESS;
            payload
        });
    Ok(Response::new(payload))
}

#[tauri::command]
pub(crate) fn report_preview_client_diagnostics(
    diagnostics: Value,
    state: State<'_, AppState>,
) -> CommandResult<()> {
    let serialized = serde_json::to_string(&diagnostics)
        .map_err(|error| format!("could not serialize preview client diagnostics: {error}"))?;
    if serialized.chars().count() > MAX_RETAINED_CLIENT_DIAGNOSTIC_CHARS {
        return Err(String::from(
            "preview client diagnostics exceeded the retained size limit",
        ));
    }
    let mut guard = state.inner.lock().map_err(|error| error.to_string())?;
    guard.preview_client_diagnostics = Some(json!({
        "receivedAt": now_unix_timestamp(),
        "snapshot": diagnostics,
    }));
    Ok(())
}

#[tauri::command]
pub(crate) fn take_preview_media_segment(
    client_generation: u64,
    state: State<'_, AppState>,
) -> CommandResult<Response> {
    let mut guard = state.inner.lock().map_err(|error| error.to_string())?;
    let payload = guard
        .live_preview_buffer
        .take_next_segment_for_client(client_generation)
        .map(|segment| {
            guard.preview_diagnostics.delivered_segments += 1;
            guard.preview_diagnostics.last_delivered_sequence_number =
                Some(segment.descriptor.sequence_number);
            guard.preview_diagnostics.last_delivered_first_sample_index =
                Some(segment.descriptor.first_sample_index);
            guard.preview_diagnostics.last_delivered_last_sample_index =
                Some(segment.descriptor.last_sample_index);

            let mut payload =
                Vec::with_capacity(PREVIEW_SEGMENT_HEADER_BYTES + segment.bytes.len());
            payload.extend_from_slice(&segment.descriptor.sequence_number.to_le_bytes());
            payload.extend_from_slice(&segment.descriptor.first_sample_index.to_le_bytes());
            payload.extend_from_slice(&segment.descriptor.last_sample_index.to_le_bytes());
            payload.push(u8::from(segment.descriptor.starts_with_keyframe));
            payload.extend_from_slice(&segment.descriptor.decode_time.to_le_bytes());
            payload.extend_from_slice(&segment.descriptor.duration.to_le_bytes());
            payload.extend_from_slice(&segment.bytes);
            payload
        })
        .unwrap_or_default();
    guard.receiver_runtime.queued_segments = guard.live_preview_buffer.queued_segment_count();
    sync_preview_diagnostics(&mut guard);
    Ok(Response::new(payload))
}

#[tauri::command]
pub(crate) fn take_preview_audio_frames(
    state: State<'_, AppState>,
) -> CommandResult<Vec<PreviewAudioFramePayload>> {
    const MAX_FRAMES_PER_POLL: usize = 24;
    let mut guard = state.inner.lock().map_err(|error| error.to_string())?;
    let count = guard.preview_audio_frames.len().min(MAX_FRAMES_PER_POLL);
    Ok(guard.preview_audio_frames.drain(..count).collect())
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
pub(crate) async fn check_for_app_update(
    app: AppHandle,
    state: State<'_, AppState>,
) -> CommandResult<Option<AppUpdateInfo>> {
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
        let mut pending = state
            .pending_update
            .lock()
            .map_err(|error| error.to_string())?;
        *pending = None;
        return Ok(None);
    };

    let info = AppUpdateInfo {
        version: update.version.clone(),
        current_version: app.package_info().version.to_string(),
        notes: update.body.clone(),
        pub_date: update.date.as_ref().map(ToString::to_string),
    };

    let mut pending = state
        .pending_update
        .lock()
        .map_err(|error| error.to_string())?;
    if pending
        .as_ref()
        .is_some_and(|cached| cached.info.version == info.version && cached.bytes.is_some())
    {
        return Ok(Some(info));
    }
    *pending = Some(PendingAppUpdate {
        info: info.clone(),
        update,
        bytes: None,
    });

    Ok(Some(info))
}

#[tauri::command]
pub(crate) fn get_downloaded_app_update(
    state: State<'_, AppState>,
) -> CommandResult<Option<AppUpdateInfo>> {
    let pending = state
        .pending_update
        .lock()
        .map_err(|error| error.to_string())?;
    Ok(pending
        .as_ref()
        .filter(|cached| cached.bytes.is_some())
        .map(|cached| cached.info.clone()))
}

#[tauri::command]
pub(crate) async fn download_app_update(
    state: State<'_, AppState>,
) -> CommandResult<Option<AppUpdateInfo>> {
    let (update, info) = {
        let pending = state
            .pending_update
            .lock()
            .map_err(|error| error.to_string())?;
        let Some(cached) = pending.as_ref() else {
            return Ok(None);
        };
        if cached.bytes.is_some() {
            return Ok(Some(cached.info.clone()));
        }
        (cached.update.clone(), cached.info.clone())
    };

    if state
        .update_download_in_progress
        .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
        .is_err()
    {
        return Err(String::from("The update is already downloading."));
    }

    let result = async {
        let bytes = update
            .download(|_, _| {}, || {})
            .await
            .map_err(|error| error.to_string())?;
        let mut pending = state
            .pending_update
            .lock()
            .map_err(|error| error.to_string())?;
        let Some(cached) = pending.as_mut() else {
            return Err(String::from(
                "The available update changed while downloading.",
            ));
        };
        if cached.info.version != info.version {
            return Err(String::from(
                "The available update changed while downloading.",
            ));
        }
        cached.bytes = Some(bytes);
        Ok(Some(info))
    }
    .await;

    state
        .update_download_in_progress
        .store(false, Ordering::Release);
    result
}

fn app_update_install_allowed(status: SessionStatus) -> bool {
    matches!(status, SessionStatus::Idle | SessionStatus::Discovering)
}

#[tauri::command]
pub(crate) fn install_app_update(
    state: State<'_, AppState>,
) -> CommandResult<Option<AppUpdateInfo>> {
    let session_guard = state.inner.lock().map_err(|error| error.to_string())?;
    if !app_update_install_allowed(session_guard.snapshot.status) {
        return Err(String::from(
            "Finish the current connection before restarting MirrorSim to update.",
        ));
    }

    let cached = state
        .pending_update
        .lock()
        .map_err(|error| error.to_string())?
        .clone();
    let Some(cached) = cached else {
        return Ok(None);
    };
    let Some(bytes) = cached.bytes else {
        return Err(String::from("The update has not finished downloading yet."));
    };

    cached
        .update
        .install(bytes)
        .map_err(|error| error.to_string())?;
    drop(session_guard);

    Ok(Some(cached.info))
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
    let require_local_approval = require_local_approval.unwrap_or(false);
    let require_known_device = require_known_device.unwrap_or(false);
    let (mut trusted_device_ids, blocked_device_ids) = pairing_device_policy(&app)?;
    if require_local_approval {
        // Ask mode challenges every sender, including devices remembered by
        // another mode. The native AirPlay prompt is the single approval step.
        trusted_device_ids.clear();
    }

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
            guard.require_local_session_approval = require_local_approval;
            guard.require_known_device = require_known_device;
            guard.native_pairing_approved_for_session = false;
            guard.snapshot.status = SessionStatus::Discovering;
            clear_pairing(&mut guard);
            reset_preview(&mut guard);
            prepare_live_transport(&mut guard, stream_id.clone());
            set_receiver_runtime_state(&mut guard, crate::models::ReceiverRuntimeState::Priming);

            if sidecar_was_running {
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
    let require_local_approval = require_local_approval.unwrap_or(false);
    let require_known_device = require_known_device.unwrap_or(false);
    let (mut trusted_device_ids, blocked_device_ids) = pairing_device_policy(&app)?;
    if require_local_approval {
        trusted_device_ids.clear();
    }

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
        guard.require_local_session_approval = require_local_approval;
        guard.require_known_device = require_known_device;
        guard.native_pairing_approved_for_session = false;
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

        if !session_status_allows_screenshot(&guard.snapshot.status) {
            return Err(String::from("session is not ready for screenshots"));
        }

        guard.snapshot.capture_count += 1;
        guard.snapshot.clone()
    };

    emit_session_status(&app, &snapshot)?;
    Ok(snapshot)
}

fn session_status_allows_screenshot(status: &SessionStatus) -> bool {
    matches!(
        status,
        SessionStatus::Connecting | SessionStatus::Mirroring | SessionStatus::Recording
    )
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

    let requested_path = validated_capture_path(&directory, &request.file_name, "png")?;
    let (mut file, file_path) = create_unique_capture_file(&requested_path)?;
    eprintln!(
        "[MirrorSim capture] saving screenshot to {}",
        file_path.display()
    );
    if let Err(error) = file.write_all(&png_bytes).and_then(|_| file.sync_all()) {
        drop(file);
        let _ = fs::remove_file(&file_path);
        return Err(error.to_string());
    }

    Ok(SavedScreenshot {
        file_name: file_path
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or(&request.file_name)
            .to_string(),
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
    let mut guard = state
        .recording_file
        .lock()
        .map_err(|error| error.to_string())?;
    if guard.is_some() {
        return Err(String::from("a recording file is already open"));
    }

    let recording_id = state.next_recording_id.fetch_add(1, Ordering::Relaxed);
    let (file, temporary_path) = create_unique_recording_temp_file(&directory, recording_id)?;
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
    // Keep this lock until persistence finishes so a new recording cannot race
    // the previous recording's final move/retry operation.
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
        .as_mut()
        .ok_or_else(|| String::from("recording file is not active"))?
        .file
        .sync_all()
        .map_err(|error| error.to_string())?;

    let recording = guard.take().expect("recording was checked above");

    let RecordingFileRuntime {
        recording_id,
        file_name,
        final_path,
        temporary_path,
        file,
        bytes_written,
    } = recording;
    drop(file);
    let final_path = match persist_recording_without_overwrite(&temporary_path, &final_path) {
        Ok(final_path) => final_path,
        Err(persist_error) => match OpenOptions::new().append(true).open(&temporary_path) {
            Ok(file) => {
                let recovery_path = temporary_path.to_string_lossy().into_owned();
                *guard = Some(RecordingFileRuntime {
                    recording_id,
                    file_name,
                    final_path,
                    temporary_path,
                    file,
                    bytes_written,
                });
                return Err(format!(
                        "could not finalize the recording: {persist_error}. The temporary recording is retained at '{recovery_path}' and finalization can be retried."
                    ));
            }
            Err(reopen_error) => {
                return Err(format!(
                        "could not finalize the recording: {persist_error}. The temporary recording remains at '{}' but could not be reopened for retry: {reopen_error}",
                        temporary_path.display()
                    ));
            }
        },
    };
    let file_name = final_path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or(&file_name)
        .to_string();

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
    // Keep the state lock through deletion so a new recording cannot reuse a
    // path that this abort is still cleaning up.
    let mut guard = state
        .recording_file
        .lock()
        .map_err(|error| error.to_string())?;
    if guard.as_ref().map(|value| value.recording_id) != Some(recording_id) {
        return Ok(());
    }
    let recording = guard.take();

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

            let should_request_keyframe =
                receiver_supports_keyframe_request(&guard.snapshot.receiver_capabilities);
            let stream_id = guard.receiver_runtime.stream_id.clone();

            resume_local_session_approval(&mut guard);
            Some((
                guard.pairing.clone(),
                guard.snapshot.clone(),
                guard.receiver_runtime.clone(),
                guard.preview_diagnostics.clone(),
                stream_id,
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
        stream_id,
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

    let transition = {
        let mut guard = state.inner.lock().map_err(|error| error.to_string())?;
        begin_pairing_confirmation(&mut guard, remember_device)?
    };

    if let Err(send_error) = send_sidecar_command(
        &state.sidecar,
        json!({
            "name": "confirm_pairing_trust",
            "session_id": transition.session_id.clone(),
            "challenge_id": transition.challenge_id.clone(),
            "remember_device": remember_device,
        }),
    ) {
        let pairing = {
            let mut guard = state.inner.lock().map_err(|error| error.to_string())?;
            rollback_pairing_confirmation(&mut guard, &transition);
            guard.pairing.clone()
        };
        let _ = emit_pairing_status(&app, &pairing);
        return Err(format!(
            "could not confirm pairing trust with the receiver: {send_error}"
        ));
    }

    let pairing = {
        let guard = state.inner.lock().map_err(|error| error.to_string())?;
        guard.pairing.clone()
    };
    emit_pairing_status(&app, &pairing)?;

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

    let (pairing, session_id, challenge_id, snapshot) = {
        let mut guard = state.inner.lock().map_err(|error| error.to_string())?;
        let session_id = guard.pairing.session_id.clone();
        let challenge_id = guard.pairing.challenge_id.clone();
        clear_pairing(&mut guard);
        let snapshot = if matches!(
            guard.snapshot.status,
            SessionStatus::Idle | SessionStatus::Discovering
        ) {
            clear_current_device_identity(&mut guard);
            Some(guard.snapshot.clone())
        } else {
            None
        };
        (guard.pairing.clone(), session_id, challenge_id, snapshot)
    };

    emit_pairing_status(&app, &pairing)?;
    if let Some(snapshot) = snapshot.as_ref() {
        emit_session_status(&app, snapshot)?;
    }

    if let (Some(session_id), Some(challenge_id)) = (session_id, challenge_id) {
        send_sidecar_command(
            &state.sidecar,
            json!({
                "name": "cancel_pairing",
                "session_id": session_id,
                "challenge_id": challenge_id,
            }),
        )?;
    }

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
    let (
        session,
        pairing,
        receiver_runtime,
        preview_diagnostics,
        preview_client_diagnostics,
        sidecar_logs,
    ) = {
        let guard = state.inner.lock().map_err(|error| error.to_string())?;
        (
            guard.snapshot.clone(),
            guard.pairing.clone(),
            guard.receiver_runtime.clone(),
            guard.preview_diagnostics.clone(),
            guard.preview_client_diagnostics.clone(),
            guard.sidecar_logs.iter().cloned().collect::<Vec<_>>(),
        )
    };
    let sidecar_spec = ReceiverSidecarSpec::direct_receiver_boundary();
    let runtime_manifest: serde_json::Value =
        serde_json::from_str(include_str!("../../receivers/runtime-manifest.json"))
            .map_err(|error| format!("bundled runtime manifest is invalid: {error}"))?;

    let mut report = json!({
        "exportedAt": now_unix_timestamp(),
        "application": {
            "name": "MirrorSim",
            "version": env!("CARGO_PKG_VERSION"),
            "targetOs": std::env::consts::OS,
            "targetArchitecture": std::env::consts::ARCH,
        },
        "receiverName": receiver_name,
        "receiverContract": sidecar_spec,
        "runtimeManifest": runtime_manifest,
        "bonjour": bonjour,
        "session": session,
        "pairing": pairing,
        "receiverRuntime": receiver_runtime,
        "previewDiagnostics": preview_diagnostics,
        "previewClientDiagnostics": preview_client_diagnostics,
        "trustedDevices": trusted_devices,
        "history": history,
        "sidecarLogs": sidecar_logs,
    });
    redact_diagnostics(&mut report);

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
    use super::{
        app_update_install_allowed, begin_pairing_confirmation, capture_path_candidate,
        mark_session_stopped, persist_recording_without_overwrite, redact_diagnostics,
        rollback_pairing_confirmation, session_status_allows_screenshot, validated_capture_path,
    };
    use crate::models::{PairingPhase, SessionStatus};
    use crate::state::SessionStore;
    use std::fs;
    use std::path::Path;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn diagnostic_exports_redact_device_and_pairing_fingerprints_everywhere() {
        let mut report = serde_json::json!({
            "session": {
                "currentDeviceId": "stable-phone-id",
                "currentDeviceKey": "stable-trust-key",
            },
            "pairing": {
                "sessionId": "session-secret",
                "challengeId": "challenge-secret",
            },
            "trustedDevices": [{
                "key": "stable-trust-key",
                "deviceId": "stable-phone-id",
            }],
            "sidecarLogs": ["phone stable-phone-id used stable-trust-key in session-secret from aa:bb:cc:dd:ee:ff"],
        });

        redact_diagnostics(&mut report);
        let serialized = serde_json::to_string(&report).expect("serialize redacted report");
        assert!(!serialized.contains("stable-phone-id"));
        assert!(!serialized.contains("stable-trust-key"));
        assert!(!serialized.contains("session-secret"));
        assert!(!serialized.contains("challenge-secret"));
        assert!(!serialized.contains("aa:bb:cc:dd:ee:ff"));
        assert!(serialized.contains("[redacted]"));
    }

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

    #[test]
    fn capture_path_candidates_add_a_no_clobber_suffix() {
        let requested = Path::new("C:/captures/MirrorSim Capture.png");
        assert_eq!(
            capture_path_candidate(requested, 1).expect("first candidate"),
            requested
        );
        assert_eq!(
            capture_path_candidate(requested, 2).expect("second candidate"),
            Path::new("C:/captures/MirrorSim Capture (2).png")
        );
    }

    #[test]
    fn screenshots_remain_available_while_transport_reconnects() {
        assert!(session_status_allows_screenshot(&SessionStatus::Connecting));
        assert!(session_status_allows_screenshot(&SessionStatus::Mirroring));
        assert!(session_status_allows_screenshot(&SessionStatus::Recording));
        assert!(!session_status_allows_screenshot(
            &SessionStatus::Discovering
        ));
        assert!(!session_status_allows_screenshot(&SessionStatus::Idle));
    }

    #[test]
    fn recording_persistence_moves_without_requiring_hard_links_or_overwriting() {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system clock")
            .as_nanos();
        let directory = std::env::temp_dir().join(format!(
            "mirrorsim-recording-persistence-{}-{unique}",
            std::process::id()
        ));
        fs::create_dir(&directory).expect("create recording test directory");

        let temporary = directory.join(".recording.webm.part");
        let requested = directory.join("MirrorSim Recording.webm");
        fs::write(&temporary, b"new recording").expect("write temporary recording");
        fs::write(&requested, b"existing recording").expect("write collision fixture");

        let saved = persist_recording_without_overwrite(&temporary, &requested)
            .expect("move recording without overwriting");
        assert_eq!(saved, directory.join("MirrorSim Recording (2).webm"));
        assert_eq!(
            fs::read(&requested).expect("read original recording"),
            b"existing recording"
        );
        assert_eq!(
            fs::read(&saved).expect("read saved recording"),
            b"new recording"
        );
        assert!(!temporary.exists());

        fs::remove_dir_all(directory).expect("remove recording test directory");
    }

    #[test]
    fn updater_install_only_runs_while_stopped_or_listening() {
        assert!(app_update_install_allowed(SessionStatus::Idle));
        assert!(app_update_install_allowed(SessionStatus::Discovering));
        assert!(!app_update_install_allowed(SessionStatus::Connecting));
        assert!(!app_update_install_allowed(SessionStatus::Mirroring));
        assert!(!app_update_install_allowed(SessionStatus::Recording));
    }

    #[test]
    fn stopping_a_session_preserves_the_running_receiver_capabilities() {
        let mut store = SessionStore {
            active_session_id: Some(String::from("session-1")),
            ..SessionStore::default()
        };
        store.snapshot.status = SessionStatus::Mirroring;
        store.snapshot.device_name = String::from("Max's iPhone");
        store.snapshot.current_device_id = Some(String::from("phone-id"));
        store.snapshot.receiver_id = Some(String::from("MirrorSim"));
        store.snapshot.receiver_protocol_version = Some(String::from("0.6.0"));
        store.snapshot.receiver_capabilities = vec![String::from("pairing-trust-control")];

        mark_session_stopped(&mut store);

        assert!(matches!(store.snapshot.status, SessionStatus::Idle));
        assert!(store.snapshot.current_device_id.is_none());
        assert_eq!(store.snapshot.receiver_id.as_deref(), Some("MirrorSim"));
        assert_eq!(
            store.snapshot.receiver_capabilities,
            vec![String::from("pairing-trust-control")]
        );
    }

    #[test]
    fn pairing_confirmation_validates_correlation_before_mutating() {
        let mut store = SessionStore {
            active_session_id: Some(String::from("session-1")),
            ..SessionStore::default()
        };
        store.pairing.phase = PairingPhase::AwaitingTrust;
        store.pairing.can_trust = true;
        store.pairing.session_id = Some(String::from("session-1"));

        assert!(begin_pairing_confirmation(&mut store, true).is_err());
        assert!(matches!(store.pairing.phase, PairingPhase::AwaitingTrust));
        assert!(!store.native_pairing_approved_for_session);
        assert!(!store.remember_pairing_approval);

        store.pairing.challenge_id = Some(String::from("challenge-1"));
        store.pairing.session_id = Some(String::from("stale-session"));
        assert!(begin_pairing_confirmation(&mut store, true).is_err());
        assert!(matches!(store.pairing.phase, PairingPhase::AwaitingTrust));
        assert!(!store.native_pairing_approved_for_session);
    }

    #[test]
    fn failed_pairing_confirmation_send_can_roll_back_transition() {
        let mut store = SessionStore {
            active_session_id: Some(String::from("session-1")),
            ..SessionStore::default()
        };
        store.pairing.phase = PairingPhase::AwaitingTrust;
        store.pairing.can_trust = true;
        store.pairing.session_id = Some(String::from("session-1"));
        store.pairing.challenge_id = Some(String::from("challenge-1"));

        let transition =
            begin_pairing_confirmation(&mut store, true).expect("valid pairing transition");
        assert!(matches!(store.pairing.phase, PairingPhase::Verifying));
        assert!(store.native_pairing_approved_for_session);
        assert!(store.remember_pairing_approval);

        rollback_pairing_confirmation(&mut store, &transition);
        assert!(matches!(store.pairing.phase, PairingPhase::AwaitingTrust));
        assert!(store.pairing.can_trust);
        assert!(!store.native_pairing_approved_for_session);
        assert!(!store.remember_pairing_approval);
    }
}
