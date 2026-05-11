use crate::history::{append_history_entry, now_unix_timestamp};
use crate::models::{
    BonjourStatusKind, BonjourStatusSnapshot, CommandResult, ConnectionHistoryEntry, PairingPhase,
    PairingSnapshot, PreviewDiagnosticsSnapshot, PreviewStreamDescriptor, PreviewTelemetry,
    ReceiverRuntimeSnapshot, ReceiverRuntimeState, ReceiverTransport, ScreenshotSaveLocation,
    SessionSnapshot, SessionStatus, SidecarEvent,
};
use crate::sidecar::ReceiverSidecarSpec;
use crate::state::{
    clear_pairing, clear_session_identity, prepare_live_transport, preview_activity,
    preview_bitrate_kbps, preview_fps_from_duration, refresh_live_preview_descriptor,
    reset_fixture_transport, reset_preview, resume_local_session_approval,
    set_receiver_runtime_state, sync_preview_diagnostics, SessionStore,
};
use crate::trust::{
    apply_current_device_trust, get_trusted_devices, note_device_connected, note_device_failure,
    note_known_device, note_pairing_state, trust_device,
};
use base64::prelude::{Engine as _, BASE64_STANDARD};
use serde_json::json;
use std::io::{BufRead, BufReader, Write};
#[cfg(windows)]
use std::os::windows::io::AsRawHandle;
#[cfg(windows)]
use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStderr, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::thread;
use tauri::{AppHandle, Emitter, Manager};
#[cfg(windows)]
use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
#[cfg(windows)]
use windows_sys::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
    SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
    JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
};

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

const SESSION_STATUS_EVENT: &str = "session-status";
const PREVIEW_TELEMETRY_EVENT: &str = "preview-telemetry";
const PREVIEW_STREAM_EVENT: &str = "preview-stream";
const RECEIVER_RUNTIME_EVENT: &str = "receiver-runtime";
const PREVIEW_DIAGNOSTICS_EVENT: &str = "preview-diagnostics";
const PAIRING_STATUS_EVENT: &str = "pairing-status";
const KEYFRAME_REQUEST_CAPABILITY: &str = "keyframe-request";

#[cfg(windows)]
struct SidecarJob {
    handle: HANDLE,
}

#[cfg(windows)]
unsafe impl Send for SidecarJob {}

#[cfg(windows)]
impl SidecarJob {
    fn create() -> CommandResult<Self> {
        let handle = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
        if handle.is_null() {
            return Err(String::from("failed to create receiver cleanup job"));
        }

        let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;

        let configured = unsafe {
            SetInformationJobObject(
                handle,
                JobObjectExtendedLimitInformation,
                std::ptr::addr_of!(limits).cast(),
                std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            )
        };

        if configured == 0 {
            unsafe {
                CloseHandle(handle);
            }
            return Err(String::from("failed to configure receiver cleanup job"));
        }

        Ok(Self { handle })
    }

    fn assign_child(&self, child: &Child) -> CommandResult<()> {
        let process_handle = child.as_raw_handle() as HANDLE;
        let assigned = unsafe { AssignProcessToJobObject(self.handle, process_handle) };
        if assigned == 0 {
            return Err(String::from(
                "failed to attach receiver process to cleanup job",
            ));
        }

        Ok(())
    }
}

#[cfg(windows)]
impl Drop for SidecarJob {
    fn drop(&mut self) {
        unsafe {
            CloseHandle(self.handle);
        }
    }
}

pub(crate) struct SidecarRuntime {
    child: Child,
    stdin: ChildStdin,
    #[cfg(windows)]
    _job: SidecarJob,
}

impl SidecarRuntime {
    fn send_command(&mut self, command: serde_json::Value) -> CommandResult<()> {
        serde_json::to_writer(&mut self.stdin, &command).map_err(|error| error.to_string())?;
        self.stdin
            .write_all(b"\n")
            .map_err(|error| error.to_string())?;
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

pub(crate) struct AppState {
    pub(crate) inner: Arc<Mutex<SessionStore>>,
    pub(crate) sidecar: Arc<Mutex<Option<SidecarRuntime>>>,
}

impl Default for AppState {
    fn default() -> Self {
        Self {
            inner: Arc::new(Mutex::new(SessionStore::default())),
            sidecar: Arc::new(Mutex::new(None)),
        }
    }
}

pub(crate) fn resolve_capture_directory(
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

pub(crate) fn emit_preview_stream(
    app: &AppHandle,
    preview_stream: &PreviewStreamDescriptor,
) -> CommandResult<()> {
    app.emit(PREVIEW_STREAM_EVENT, preview_stream.clone())
        .map_err(|error| error.to_string())
}

pub(crate) fn emit_session_status(
    app: &AppHandle,
    snapshot: &SessionSnapshot,
) -> CommandResult<()> {
    app.emit(SESSION_STATUS_EVENT, snapshot.clone())
        .map_err(|error| error.to_string())
}

pub(crate) fn emit_preview_telemetry(
    app: &AppHandle,
    preview: &PreviewTelemetry,
) -> CommandResult<()> {
    app.emit(PREVIEW_TELEMETRY_EVENT, preview.clone())
        .map_err(|error| error.to_string())
}

pub(crate) fn emit_receiver_runtime(
    app: &AppHandle,
    receiver_runtime: &ReceiverRuntimeSnapshot,
) -> CommandResult<()> {
    app.emit(RECEIVER_RUNTIME_EVENT, receiver_runtime.clone())
        .map_err(|error| error.to_string())
}

pub(crate) fn emit_preview_diagnostics(
    app: &AppHandle,
    preview_diagnostics: &PreviewDiagnosticsSnapshot,
) -> CommandResult<()> {
    app.emit(PREVIEW_DIAGNOSTICS_EVENT, preview_diagnostics.clone())
        .map_err(|error| error.to_string())
}

pub(crate) fn emit_pairing_status(app: &AppHandle, pairing: &PairingSnapshot) -> CommandResult<()> {
    app.emit(PAIRING_STATUS_EVENT, pairing.clone())
        .map_err(|error| error.to_string())
}

pub(crate) fn emit_state_updates(
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

// This is the main failure-recovery path for the desktop shell. Keep the state
// transition and the emitted snapshots together so the UI never observes a
// partially-reset session after the sidecar drops or emits malformed data.
pub(crate) fn emit_runtime_error(
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
            clear_session_identity(&mut guard);
            clear_pairing(&mut guard);
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

#[cfg(windows)]
pub(crate) fn query_bonjour_status() -> BonjourStatusSnapshot {
    const SERVICE_NAME: &str = "Bonjour Service";

    let mut command = Command::new("sc");
    command
        .args(["query", SERVICE_NAME])
        .creation_flags(CREATE_NO_WINDOW);

    let output = command.output();

    match output {
        Ok(output) => {
            let stdout = String::from_utf8_lossy(&output.stdout).to_lowercase();
            let stderr = String::from_utf8_lossy(&output.stderr).to_lowercase();
            let combined = format!("{}\n{}", stdout, stderr);

            if combined.contains("does not exist as an installed service") {
                return BonjourStatusSnapshot {
                    status: BonjourStatusKind::Missing,
                    service_name: SERVICE_NAME.to_string(),
                    detail: String::from(
                        "Bonjour for Windows is not installed. Install it so your iPhone can discover this PC over AirPlay.",
                    ),
                };
            }

            if combined.contains("state") && combined.contains("running") {
                return BonjourStatusSnapshot {
                    status: BonjourStatusKind::Ready,
                    service_name: SERVICE_NAME.to_string(),
                    detail: String::from("Bonjour Service is installed and running."),
                };
            }

            if combined.contains("state") {
                return BonjourStatusSnapshot {
                    status: BonjourStatusKind::Stopped,
                    service_name: SERVICE_NAME.to_string(),
                    detail: String::from(
                        "Bonjour Service is installed but not running. Start the service in Windows Services before using discovery.",
                    ),
                };
            }

            BonjourStatusSnapshot {
                status: BonjourStatusKind::Unknown,
                service_name: SERVICE_NAME.to_string(),
                detail: String::from(
                    "MirrorSim could not determine whether Bonjour Service is available. If discovery fails, verify Bonjour is installed and running.",
                ),
            }
        }
        Err(error) => BonjourStatusSnapshot {
            status: BonjourStatusKind::Unknown,
            service_name: SERVICE_NAME.to_string(),
            detail: format!(
                "MirrorSim could not query Bonjour Service ({}). If discovery fails, verify Bonjour is installed and running.",
                error
            ),
        },
    }
}

#[cfg(not(windows))]
pub(crate) fn query_bonjour_status() -> BonjourStatusSnapshot {
    BonjourStatusSnapshot {
        status: BonjourStatusKind::Unknown,
        service_name: String::from("Bonjour Service"),
        detail: String::from("Bonjour status checks are only available on Windows."),
    }
}

pub(crate) fn bonjour_blocking_message(status: &BonjourStatusSnapshot) -> Option<String> {
    match status.status {
        BonjourStatusKind::Missing | BonjourStatusKind::Stopped => Some(status.detail.clone()),
        BonjourStatusKind::Ready | BonjourStatusKind::Unknown => None,
    }
}

// Sidecar events can mutate multiple pieces of session state at once. Handle a
// whole event under one lock and emit a consistent snapshot afterwards instead
// of scattering updates across smaller helper calls.
fn handle_sidecar_event(
    app: &AppHandle,
    store: &Arc<Mutex<SessionStore>>,
    sidecar: &Arc<Mutex<Option<SidecarRuntime>>>,
    event: SidecarEvent,
) -> CommandResult<()> {
    let mut request_keyframe: Option<(String, String)> = None;
    let mut stop_session_request: Option<String> = None;
    let mut history_entries: Vec<ConnectionHistoryEntry> = Vec::new();

    let (snapshot, preview, preview_stream, receiver_runtime, preview_diagnostics, pairing) = {
        let mut guard = store.lock().map_err(|error| error.to_string())?;
        let mut emit_snapshot = false;
        let mut emit_preview = false;
        let mut emit_preview_stream = false;
        let mut emit_pairing = false;

        match event {
            SidecarEvent::ReceiverReady {
                receiver_id,
                protocol_version,
                capabilities,
            } => {
                guard.receiver_runtime.transport = ReceiverTransport::Airplayserver;
                guard.snapshot.receiver_id = Some(receiver_id.clone());
                guard.snapshot.receiver_protocol_version = Some(protocol_version.clone());
                guard.snapshot.receiver_capabilities = capabilities.clone();
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
                device_id,
                device_model,
                device_os_name,
                device_os_version,
                device_os_build_version,
                device_source_version,
            } => {
                let trusted_devices = note_device_connected(
                    app,
                    &device_name,
                    device_id.as_deref(),
                    device_model.as_deref(),
                    device_os_name.as_deref(),
                    device_os_version.as_deref(),
                    device_os_build_version.as_deref(),
                    device_source_version.as_deref(),
                )?;
                guard.active_session_id = Some(session_id);
                guard.snapshot.device_name = device_name.clone();
                guard.snapshot.current_device_id = device_id.clone();
                guard.snapshot.current_device_model = device_model.clone();
                guard.snapshot.current_device_os_name = device_os_name.clone();
                guard.snapshot.current_device_os_version = device_os_version.clone();
                guard.snapshot.current_device_os_build_version = device_os_build_version.clone();
                guard.snapshot.current_device_source_version = device_source_version.clone();
                apply_current_device_trust(&mut guard.snapshot, &trusted_devices);
                clear_pairing(&mut guard);
                guard.snapshot.status = SessionStatus::Connecting;
                prepare_live_transport(&mut guard, stream_id);
                set_receiver_runtime_state(&mut guard, ReceiverRuntimeState::Ready);

                let (history_status, history_message) = if guard.snapshot.current_device_blocked {
                    guard.pairing.phase = PairingPhase::Failed;
                    guard.pairing.entry_mode = crate::models::PairingEntryMode::ConfirmOnly;
                    guard.pairing.device_name = Some(device_name.clone());
                    guard.pairing.device_id = device_id.clone();
                    guard.pairing.prompt = None;
                    guard.pairing.display_pin = None;
                    guard.pairing.failure_message = Some(
                        guard
                            .snapshot
                            .current_device_blocked_reason
                            .clone()
                            .unwrap_or_else(|| String::from("This iPhone is blocked on this PC.")),
                    );
                    guard.pairing.can_trust = false;
                    guard.receiver_runtime.last_error = guard.pairing.failure_message.clone();
                    stop_session_request = guard.active_session_id.clone();
                    emit_pairing = true;
                    (
                        String::from("warning"),
                        format!(
                            "{} was rejected because this iPhone is blocked on this PC.",
                            device_name
                        ),
                    )
                } else if guard.require_known_device && !guard.snapshot.current_device_known {
                    guard.pairing.phase = PairingPhase::Failed;
                    guard.pairing.entry_mode = crate::models::PairingEntryMode::ConfirmOnly;
                    guard.pairing.device_name = Some(device_name.clone());
                    guard.pairing.device_id = device_id.clone();
                    guard.pairing.prompt = None;
                    guard.pairing.display_pin = None;
                    guard.pairing.failure_message = Some(String::from(
                        "This iPhone is not known on this PC yet. Start MirrorSim in Ask or Remember mode once to approve it first.",
                    ));
                    guard.pairing.can_trust = false;
                    guard.receiver_runtime.last_error = guard.pairing.failure_message.clone();
                    stop_session_request = guard.active_session_id.clone();
                    emit_pairing = true;
                    (
                        String::from("warning"),
                        format!(
                            "{} was rejected because it is not known on this PC yet.",
                            device_name
                        ),
                    )
                } else if guard.require_local_session_approval
                    && !guard.snapshot.current_device_trusted
                {
                    guard.pending_local_session_approval = true;
                    guard.pairing.phase = PairingPhase::AwaitingTrust;
                    guard.pairing.entry_mode = crate::models::PairingEntryMode::ConfirmOnly;
                    guard.pairing.device_name = Some(device_name.clone());
                    guard.pairing.device_id = device_id.clone();
                    guard.pairing.display_pin = None;
                    guard.pairing.failure_message = None;
                    guard.pairing.prompt = Some(String::from(
                        "Approve this iPhone for the current session. MirrorSim will ask again next time unless you remember it.",
                    ));
                    guard.pairing.can_trust = true;
                    guard.receiver_runtime.last_error = Some(String::from(
                        "receiver connected; waiting for local approval before MirrorSim starts streaming",
                    ));
                    emit_pairing = true;
                    (
                        String::from("info"),
                        format!(
                            "{} connected and is waiting for local approval.",
                            device_name
                        ),
                    )
                } else {
                    guard.receiver_runtime.last_error = Some(String::from(
                        "receiver connected; waiting for the first H.264 frame from the iPhone",
                    ));
                    emit_pairing = true;
                    (
                        String::from("success"),
                        format!("{} connected to MirrorSim.", device_name),
                    )
                };

                emit_snapshot = true;
                emit_preview_stream = true;

                history_entries.push(ConnectionHistoryEntry {
                    id: String::new(),
                    occurred_at: now_unix_timestamp(),
                    event: String::from("session-started"),
                    status: history_status,
                    message: history_message,
                    device_name: Some(device_name),
                    device_id: device_id,
                    device_model: device_model,
                    device_os_name: device_os_name,
                    device_os_version: device_os_version,
                    device_key: guard.snapshot.current_device_key.clone(),
                    receiver_name: guard.snapshot.receiver_id.clone(),
                });
            }
            SidecarEvent::PairingStateChanged {
                phase,
                entry_mode,
                device_name,
                device_id,
                display_pin,
                prompt,
                failure_message,
                can_trust,
            } => {
                let awaiting_trust_confirmation = guard.pairing.can_trust
                    || matches!(guard.pairing.phase, PairingPhase::AwaitingTrust);

                if let Some(device_name) = device_name {
                    guard.snapshot.device_name = device_name.clone();
                    guard.pairing.device_name = Some(device_name);
                    emit_snapshot = true;
                }

                if let Some(device_id) = device_id {
                    guard.snapshot.current_device_id = Some(device_id.clone());
                    guard.pairing.device_id = Some(device_id);
                    let trusted_devices = get_trusted_devices(app)?;
                    apply_current_device_trust(&mut guard.snapshot, &trusted_devices);
                    emit_snapshot = true;
                }

                guard.pairing.phase = phase;
                guard.pairing.entry_mode = entry_mode;
                guard.pairing.display_pin = display_pin;
                guard.pairing.prompt = prompt;
                guard.pairing.failure_message = failure_message;
                guard.pairing.can_trust = can_trust;

                if !guard.snapshot.device_name.is_empty() {
                    let trusted_devices = note_pairing_state(
                        app,
                        &guard.snapshot.device_name,
                        guard.snapshot.current_device_id.as_deref(),
                        guard.snapshot.current_device_model.as_deref(),
                        guard.snapshot.current_device_os_name.as_deref(),
                        guard.snapshot.current_device_os_version.as_deref(),
                        guard.snapshot.current_device_os_build_version.as_deref(),
                        guard.snapshot.current_device_source_version.as_deref(),
                        matches!(
                            phase,
                            PairingPhase::PinRequired
                                | PairingPhase::AwaitingTrust
                                | PairingPhase::Verifying
                        ),
                        guard.pairing.failure_message.as_deref(),
                    )?;
                    apply_current_device_trust(&mut guard.snapshot, &trusted_devices);
                    emit_snapshot = true;
                }

                if matches!(phase, PairingPhase::Paired) {
                    guard.pairing.display_pin = None;
                    guard.pairing.prompt = None;
                    guard.pairing.failure_message = None;
                    guard.pairing.can_trust = false;

                    if awaiting_trust_confirmation && !guard.snapshot.device_name.is_empty() {
                        let trusted_devices = if guard.remember_pairing_approval {
                            trust_device(
                                app,
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
                                app,
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
                        emit_snapshot = true;
                    }

                    if guard.pending_local_session_approval {
                        resume_local_session_approval(&mut guard);
                        emit_snapshot = true;
                        if guard
                            .snapshot
                            .receiver_capabilities
                            .iter()
                            .any(|capability| capability == KEYFRAME_REQUEST_CAPABILITY)
                        {
                            request_keyframe = guard.active_session_id.as_ref().map(|_| {
                                (
                                    guard.receiver_runtime.stream_id.clone(),
                                    String::from("pairing_approved"),
                                )
                            });
                        }
                    }
                }

                history_entries.push(ConnectionHistoryEntry {
                    id: String::new(),
                    occurred_at: now_unix_timestamp(),
                    event: format!("pairing-{}", serde_variant_name(&phase)),
                    status: if matches!(phase, PairingPhase::Failed) {
                        String::from("error")
                    } else if matches!(phase, PairingPhase::Paired) {
                        String::from("success")
                    } else {
                        String::from("info")
                    },
                    message: guard
                        .pairing
                        .failure_message
                        .clone()
                        .or_else(|| guard.pairing.prompt.clone())
                        .unwrap_or_else(|| {
                            format!("Pairing moved to {}.", serde_variant_name(&phase))
                        }),
                    device_name: Some(guard.snapshot.device_name.clone()),
                    device_id: guard.snapshot.current_device_id.clone(),
                    device_model: guard.snapshot.current_device_model.clone(),
                    device_os_name: guard.snapshot.current_device_os_name.clone(),
                    device_os_version: guard.snapshot.current_device_os_version.clone(),
                    device_key: guard.snapshot.current_device_key.clone(),
                    receiver_name: guard.snapshot.receiver_id.clone(),
                });

                emit_pairing = true;
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
                let waiting_for_local_approval = guard.pending_local_session_approval;

                if guard.receiver_runtime.stream_id != stream_id {
                    prepare_live_transport(&mut guard, stream_id.clone());
                    emit_preview_stream = true;
                }

                let payload = BASE64_STANDARD
                    .decode(payload_base64.as_bytes())
                    .map_err(|error| format!("failed to decode receiver payload: {}", error))?;
                let size_bytes = payload.len();
                guard.remux_blueprint.push_access_unit(
                    sample_index,
                    size_bytes,
                    keyframe,
                    dts,
                    pts,
                    duration,
                );
                let push_result = guard.live_preview_buffer.push_access_unit(
                    sample_index,
                    payload,
                    keyframe,
                    dts,
                    pts,
                    duration,
                )?;
                guard.preview_diagnostics.last_access_unit_index = Some(sample_index);
                guard.preview_diagnostics.last_access_unit_duration = Some(duration);
                if push_result.init_segment_became_available {
                    if let Some(track) = guard.live_preview_buffer.track_config() {
                        guard.remux_blueprint.track = track.clone();
                        guard.remux_blueprint.mime_type =
                            format!("video/mp4; codecs=\"{}\"", track.codec);
                        refresh_live_preview_descriptor(&mut guard);
                        emit_preview_stream = true;
                    }
                }

                if let Some(segment) = push_result.emitted_segment {
                    guard.preview_diagnostics.emitted_segments += 1;
                    guard.preview_diagnostics.last_queued_sequence_number =
                        Some(segment.sequence_number);
                    guard.preview_diagnostics.last_queued_first_sample_index =
                        Some(segment.first_sample_index);
                    guard.preview_diagnostics.last_queued_last_sample_index =
                        Some(segment.last_sample_index);
                    guard.preview_diagnostics.last_queued_duration = Some(segment.duration);
                }

                if waiting_for_local_approval {
                    guard.snapshot.status = SessionStatus::Connecting;
                    guard.receiver_runtime.transport = ReceiverTransport::Airplayserver;
                    guard.receiver_runtime.stream_id = stream_id;
                    guard.receiver_runtime.state = ReceiverRuntimeState::Ready;
                    guard.receiver_runtime.queued_segments =
                        guard.live_preview_buffer.queued_segment_count();
                    guard.receiver_runtime.last_error = Some(String::from(
                        "waiting for local approval before MirrorSim starts streaming",
                    ));
                    emit_snapshot = true;
                } else if !push_result.sample_enqueued {
                    guard.snapshot.status = SessionStatus::Connecting;
                    guard.receiver_runtime.transport = ReceiverTransport::Airplayserver;
                    guard.receiver_runtime.stream_id = stream_id;
                    guard.receiver_runtime.state = ReceiverRuntimeState::Ready;
                    guard.receiver_runtime.queued_segments =
                        guard.live_preview_buffer.queued_segment_count();
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
                    guard.receiver_runtime.queued_segments =
                        guard.live_preview_buffer.queued_segment_count();
                    guard.receiver_runtime.last_error = None;

                    guard.preview.frame_number = sample_index as u64 + 1;
                    let preview_timescale = guard.remux_blueprint.track.timescale;
                    guard.preview.fps = preview_fps_from_duration(duration, preview_timescale);
                    guard.preview.bitrate_kbps =
                        preview_bitrate_kbps(size_bytes, duration, preview_timescale);
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
                guard.receiver_runtime.last_error =
                    Some(format!("stream discontinuity: {}", reason));

                if matches!(
                    guard.snapshot.status,
                    SessionStatus::Mirroring | SessionStatus::Recording
                ) {
                    guard.snapshot.status = SessionStatus::Connecting;
                    emit_snapshot = true;
                }

                if requires_init_segment_refresh {
                    reset_preview(&mut guard);
                    emit_preview = true;
                    emit_preview_stream = true;
                    if guard
                        .snapshot
                        .receiver_capabilities
                        .iter()
                        .any(|capability| capability == KEYFRAME_REQUEST_CAPABILITY)
                    {
                        request_keyframe = Some((stream_id, reason.clone()));
                    }
                }

                history_entries.push(ConnectionHistoryEntry {
                    id: String::new(),
                    occurred_at: now_unix_timestamp(),
                    event: String::from("stream-discontinuity"),
                    status: String::from("warning"),
                    message: format!("Stream discontinuity: {}", reason),
                    device_name: Some(guard.snapshot.device_name.clone()),
                    device_id: guard.snapshot.current_device_id.clone(),
                    device_model: guard.snapshot.current_device_model.clone(),
                    device_os_name: guard.snapshot.current_device_os_name.clone(),
                    device_os_version: guard.snapshot.current_device_os_version.clone(),
                    device_key: guard.snapshot.current_device_key.clone(),
                    receiver_name: guard.snapshot.receiver_id.clone(),
                });

                sync_preview_diagnostics(&mut guard);
            }
            SidecarEvent::ReceiverError {
                code,
                message,
                recoverable,
            } => {
                let snapshot = guard.snapshot.clone();
                drop(guard);

                if !matches!(snapshot.status, SessionStatus::Idle) {
                    let _ = note_device_failure(
                        app,
                        &snapshot.device_name,
                        snapshot.current_device_id.as_deref(),
                        snapshot.current_device_model.as_deref(),
                        snapshot.current_device_os_name.as_deref(),
                        snapshot.current_device_os_version.as_deref(),
                        snapshot.current_device_os_build_version.as_deref(),
                        snapshot.current_device_source_version.as_deref(),
                        &message,
                    );
                }

                let _ = append_history_entry(
                    app,
                    ConnectionHistoryEntry {
                        id: String::new(),
                        occurred_at: now_unix_timestamp(),
                        event: String::from("receiver-error"),
                        status: if recoverable {
                            String::from("warning")
                        } else {
                            String::from("error")
                        },
                        message: format!("{}: {}", code, message),
                        device_name: Some(snapshot.device_name),
                        device_id: snapshot.current_device_id,
                        device_model: snapshot.current_device_model,
                        device_os_name: snapshot.current_device_os_name,
                        device_os_version: snapshot.current_device_os_version,
                        device_key: snapshot.current_device_key,
                        receiver_name: snapshot.receiver_id,
                    },
                );

                return emit_runtime_error(
                    app,
                    store,
                    format!("{}: {}", code, message),
                    recoverable,
                );
            }
        }

        (
            emit_snapshot.then(|| guard.snapshot.clone()),
            emit_preview.then(|| guard.preview.clone()),
            emit_preview_stream.then(|| guard.preview_stream.clone()),
            Some(guard.receiver_runtime.clone()),
            Some(guard.preview_diagnostics.clone()),
            emit_pairing.then(|| guard.pairing.clone()),
        )
    };

    emit_state_updates(
        app,
        snapshot,
        preview,
        preview_stream,
        receiver_runtime,
        preview_diagnostics,
    )?;
    if let Some(pairing) = pairing.as_ref() {
        emit_pairing_status(app, pairing)?;
    }

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

    if let Some(session_id) = stop_session_request {
        let _ = send_sidecar_command(
            sidecar,
            json!({
                "name": "stop_session",
                "session_id": session_id,
            }),
        );
    }

    for entry in history_entries {
        let _ = append_history_entry(app, entry);
    }

    Ok(())
}

fn serde_variant_name(phase: &PairingPhase) -> &'static str {
    match phase {
        PairingPhase::Idle => "idle",
        PairingPhase::PinRequired => "pin-required",
        PairingPhase::AwaitingTrust => "awaiting-trust",
        PairingPhase::Verifying => "verifying",
        PairingPhase::Paired => "paired",
        PairingPhase::Failed => "failed",
    }
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
                    let _ = emit_runtime_error(
                        &app,
                        &store,
                        format!("receiver output error: {}", error),
                        true,
                    );
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
            let _ = emit_runtime_error(
                &app,
                &store,
                String::from("receiver sidecar exited unexpectedly"),
                false,
            );
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

pub(crate) fn ensure_sidecar_runtime(app: &AppHandle, state: &AppState) -> CommandResult<bool> {
    let mut sidecar_guard = state.sidecar.lock().map_err(|error| error.to_string())?;
    if sidecar_guard.is_some() {
        return Ok(false);
    }

    let spec = ReceiverSidecarSpec::direct_receiver_boundary();
    let executable = resolve_sidecar_path(app, &spec.launch.executable)?;
    let working_directory = resolve_sidecar_path(app, &spec.launch.working_directory)?;

    #[cfg(windows)]
    let sidecar_job = SidecarJob::create()?;

    let mut command = Command::new(&executable);
    command
        .args(&spec.launch.args)
        .current_dir(working_directory)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    #[cfg(windows)]
    command.creation_flags(CREATE_NO_WINDOW);

    let mut child = command.spawn().map_err(|error| {
        format!(
            "failed to launch receiver sidecar '{}': {}",
            executable.display(),
            error
        )
    })?;

    #[cfg(windows)]
    if let Err(error) = sidecar_job.assign_child(&child) {
        let _ = child.kill();
        let _ = child.wait();
        return Err(error);
    }

    let stdin = child
        .stdin
        .take()
        .ok_or_else(|| String::from("receiver sidecar stdin was unavailable"))?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| String::from("receiver sidecar stdout was unavailable"))?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| String::from("receiver sidecar stderr was unavailable"))?;

    spawn_sidecar_stdout_loop(
        app.clone(),
        state.inner.clone(),
        state.sidecar.clone(),
        stdout,
    );
    spawn_sidecar_stderr_loop(app.clone(), state.inner.clone(), stderr);

    *sidecar_guard = Some(SidecarRuntime {
        child,
        stdin,
        #[cfg(windows)]
        _job: sidecar_job,
    });
    Ok(true)
}

pub(crate) fn send_sidecar_command(
    sidecar: &Arc<Mutex<Option<SidecarRuntime>>>,
    command: serde_json::Value,
) -> CommandResult<()> {
    let mut guard = sidecar.lock().map_err(|error| error.to_string())?;
    let runtime = guard
        .as_mut()
        .ok_or_else(|| String::from("receiver sidecar is not running"))?;

    runtime.send_command(command)
}

pub(crate) fn ensure_bonjour_ready() -> CommandResult<()> {
    let bonjour = query_bonjour_status();
    if let Some(message) = bonjour_blocking_message(&bonjour) {
        return Err(message);
    }

    Ok(())
}
