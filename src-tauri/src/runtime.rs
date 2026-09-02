use crate::history::{append_history_entry, now_unix_timestamp};
use crate::models::{
    AppUpdateInfo, BonjourStatusKind, BonjourStatusSnapshot, CommandResult, ConnectionHistoryEntry,
    PairingPhase, PairingSnapshot, PreviewDiagnosticsSnapshot, PreviewStreamDescriptor,
    PreviewTelemetry, ReceiverRuntimeSnapshot, ReceiverRuntimeState, ReceiverTransport,
    ScreenshotSaveLocation, SessionSnapshot, SessionStatus, SidecarEvent,
};
use crate::preview_fragments::normalize_preview_sample_duration;
use crate::sidecar::ReceiverSidecarSpec;
use crate::state::{
    clear_pairing, clear_session_identity, mark_pairing_challenge_closed,
    pairing_challenge_is_closed, prepare_live_transport, preview_activity, preview_bitrate_kbps,
    preview_fps_from_duration, refresh_live_preview_descriptor, reset_fixture_transport,
    reset_preview, resume_listening_after_disconnect, resume_local_session_approval,
    set_receiver_runtime_state, sync_preview_diagnostics, SessionStore,
};
use crate::trust::{
    apply_current_device_trust, get_trusted_devices, note_device_connected, note_device_failure,
    note_known_device, note_pairing_state, trust_device,
};
use base64::prelude::{Engine as _, BASE64_STANDARD};
use serde_json::json;
use std::fs::File;
use std::io::{BufRead, BufReader, Write};
#[cfg(windows)]
use std::os::windows::process::CommandExt;
#[cfg(windows)]
use std::os::windows::{ffi::OsStrExt, io::AsRawHandle};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStderr, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager};
#[cfg(windows)]
use windows_sys::Win32::Foundation::{
    CloseHandle, GetLastError, ERROR_SERVICE_DOES_NOT_EXIST, HANDLE,
};
#[cfg(windows)]
use windows_sys::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
    SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
    JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
};
#[cfg(windows)]
use windows_sys::Win32::System::Services::{
    CloseServiceHandle, OpenSCManagerW, OpenServiceW, QueryServiceStatus, SC_MANAGER_CONNECT,
    SERVICE_QUERY_STATUS, SERVICE_RUNNING, SERVICE_STATUS,
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
const CONNECTING_MEDIA_TIMEOUT: Duration = Duration::from_secs(12);
const CONNECTING_WATCHDOG_INTERVAL: Duration = Duration::from_millis(250);
const EXPECTED_RECEIVER_PROTOCOL_VERSION: &str = "0.5.0";
const MAX_RECEIVER_EVENT_LINE_BYTES: usize = 12 * 1024 * 1024;
const MAX_VIDEO_ACCESS_UNIT_BYTES: usize = 8 * 1024 * 1024;
const MAX_SIDECAR_RESTART_ATTEMPTS: u8 = 3;
const SIDECAR_RESTART_STABILITY_WINDOW: Duration = Duration::from_secs(10);
const MAX_RETAINED_SIDECAR_LOG_LINES: usize = 200;
const MAX_RETAINED_SIDECAR_LOG_CHARS: usize = 2_000;

fn receiver_supports_keyframe_request(capabilities: &[String]) -> bool {
    capabilities
        .iter()
        .any(|capability| capability == KEYFRAME_REQUEST_CAPABILITY)
}

fn session_accepts_media(store: &SessionStore, stream_id: &str) -> bool {
    store.active_session_id.is_some()
        && !matches!(
            store.snapshot.status,
            SessionStatus::Idle | SessionStatus::Discovering
        )
        && !store.snapshot.current_device_blocked
        && (!store.require_known_device || store.snapshot.current_device_known)
        && store.receiver_runtime.stream_id == stream_id
}

fn media_timeline_restarted(previous_sample_index: Option<u32>, sample_index: u32) -> bool {
    previous_sample_index.is_some_and(|previous| sample_index <= previous)
}

#[derive(Debug, PartialEq, Eq)]
enum ConnectingWatchdogState {
    Stop,
    WaitingForApproval,
    WaitingForMedia,
    Healthy,
}

fn connecting_watchdog_state(
    store: &SessionStore,
    connection_attempt_generation: u64,
    session_id: &str,
    stream_id: &str,
) -> ConnectingWatchdogState {
    if store.connection_attempt_generation != connection_attempt_generation
        || store.active_session_id.as_deref() != Some(session_id)
        || store.receiver_runtime.stream_id != stream_id
        || matches!(
            store.snapshot.status,
            SessionStatus::Idle | SessionStatus::Discovering
        )
    {
        return ConnectingWatchdogState::Stop;
    }

    match store.snapshot.status {
        SessionStatus::Connecting if store.pending_local_session_approval => {
            ConnectingWatchdogState::WaitingForApproval
        }
        SessionStatus::Connecting => ConnectingWatchdogState::WaitingForMedia,
        SessionStatus::Mirroring | SessionStatus::Recording => ConnectingWatchdogState::Healthy,
        SessionStatus::Idle | SessionStatus::Discovering => ConnectingWatchdogState::Stop,
    }
}

fn needs_local_session_approval(store: &SessionStore) -> bool {
    store.require_local_session_approval
        && !store.snapshot.current_device_trusted
        && !store.native_pairing_approved_for_session
}

fn pairing_policy_rejection(store: &SessionStore) -> Option<String> {
    if store.snapshot.current_device_blocked {
        return Some(
            store
                .snapshot
                .current_device_blocked_reason
                .clone()
                .unwrap_or_else(|| String::from("This iPhone is blocked on this PC.")),
        );
    }

    if store.require_known_device
        && store.snapshot.current_device_key.is_some()
        && !store.snapshot.current_device_known
    {
        return Some(String::from(
            "This iPhone is not known on this PC yet. Switch Device Trust to Ask Each Time or Remember Approved iPhones, connect once, and approve it first.",
        ));
    }

    None
}

#[derive(Debug, PartialEq, Eq)]
enum PairingEventCorrelation {
    Accept,
    IgnoreStale,
    IgnoreClosedReplay,
}

fn validate_pairing_event_correlation(
    store: &SessionStore,
    phase: PairingPhase,
    session_id: Option<&str>,
    challenge_id: Option<&str>,
) -> CommandResult<PairingEventCorrelation> {
    let session_id = session_id
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| String::from("pairing event is missing its session identity"))?;
    let challenge_id = challenge_id
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| String::from("pairing event is missing its challenge identity"))?;

    if store.active_session_id.as_deref() != Some(session_id) {
        return Ok(PairingEventCorrelation::IgnoreStale);
    }

    if pairing_challenge_is_closed(store, session_id, challenge_id) {
        return Ok(PairingEventCorrelation::IgnoreClosedReplay);
    }

    if let (Some(current_session_id), Some(current_challenge_id)) = (
        store.pairing.session_id.as_deref(),
        store.pairing.challenge_id.as_deref(),
    ) {
        let current_pairing_is_terminal = matches!(
            store.pairing.phase,
            PairingPhase::Idle | PairingPhase::Paired | PairingPhase::Failed
        );
        if !current_pairing_is_terminal
            && (current_session_id != session_id || current_challenge_id != challenge_id)
        {
            return Err(format!(
                "pairing event challenge does not match the active {} pairing challenge",
                serde_variant_name(&phase)
            ));
        }
    }

    Ok(PairingEventCorrelation::Accept)
}

fn should_reset_sidecar_restart_budget(
    restart_attempt: u8,
    uptime: Duration,
    accepted_media: bool,
) -> bool {
    restart_attempt > 0 && accepted_media && uptime >= SIDECAR_RESTART_STABILITY_WINDOW
}

fn sidecar_generation_is_current(
    sidecar: &Arc<Mutex<Option<SidecarRuntime>>>,
    generation: u64,
) -> bool {
    sidecar
        .lock()
        .ok()
        .and_then(|guard| {
            guard
                .as_ref()
                .map(|runtime| runtime.generation == generation)
        })
        .unwrap_or(false)
}

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
    generation: u64,
    child: Child,
    stdin: ChildStdin,
    restart_command: Option<serde_json::Value>,
    restart_attempt: u8,
    started_at: Instant,
    #[cfg(windows)]
    _job: SidecarJob,
}

impl SidecarRuntime {
    fn send_command(&mut self, command: serde_json::Value) -> CommandResult<()> {
        serde_json::to_writer(&mut self.stdin, &command).map_err(|error| error.to_string())?;
        self.stdin
            .write_all(b"\n")
            .map_err(|error| error.to_string())?;
        self.stdin.flush().map_err(|error| error.to_string())?;

        match command.get("name").and_then(serde_json::Value::as_str) {
            Some("start_session") => self.restart_command = Some(command),
            Some("stop_session" | "shutdown") => self.restart_command = None,
            _ => {}
        }

        Ok(())
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
    next_sidecar_generation: Arc<AtomicU64>,
    pub(crate) recording_file: Arc<Mutex<Option<RecordingFileRuntime>>>,
    pub(crate) next_recording_id: AtomicU64,
    pub(crate) pending_update: Arc<Mutex<Option<PendingAppUpdate>>>,
    pub(crate) update_download_in_progress: AtomicBool,
}

#[derive(Clone)]
pub(crate) struct PendingAppUpdate {
    pub(crate) info: AppUpdateInfo,
    pub(crate) update: tauri_plugin_updater::Update,
    pub(crate) bytes: Option<Vec<u8>>,
}

pub(crate) struct RecordingFileRuntime {
    pub(crate) recording_id: u64,
    pub(crate) file_name: String,
    pub(crate) final_path: PathBuf,
    pub(crate) temporary_path: PathBuf,
    pub(crate) file: File,
    pub(crate) bytes_written: u64,
}

impl Default for AppState {
    fn default() -> Self {
        Self {
            inner: Arc::new(Mutex::new(SessionStore::default())),
            sidecar: Arc::new(Mutex::new(None)),
            next_sidecar_generation: Arc::new(AtomicU64::new(1)),
            recording_file: Arc::new(Mutex::new(None)),
            next_recording_id: AtomicU64::new(1),
            pending_update: Arc::new(Mutex::new(None)),
            update_download_in_progress: AtomicBool::new(false),
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
    let relative = Path::new(relative_path);
    let mut candidates = Vec::new();

    if let Ok(resource_dir) = app.path().resource_dir() {
        push_sidecar_candidates(&mut candidates, &resource_dir, relative);
    }

    if let Ok(executable_path) = std::env::current_exe() {
        if let Some(executable_dir) = executable_path.parent() {
            push_sidecar_candidates(&mut candidates, executable_dir, relative);
        }
    }

    #[cfg(debug_assertions)]
    {
        let current_dir = std::env::current_dir().map_err(|error| error.to_string())?;
        push_sidecar_candidates(&mut candidates, &current_dir, relative);
        push_sidecar_candidates(&mut candidates, &current_dir.join("src-tauri"), relative);
        if let Some(parent) = current_dir.parent() {
            push_sidecar_candidates(&mut candidates, parent, relative);
        }
    }

    for candidate in &candidates {
        if candidate.exists() {
            return candidate.canonicalize().map_err(|error| {
                format!(
                    "failed to resolve receiver path '{}': {}",
                    candidate.display(),
                    error
                )
            });
        }
    }

    let searched_paths = candidates
        .iter()
        .map(|candidate| candidate.display().to_string())
        .collect::<Vec<_>>()
        .join(", ");

    Err(format!(
        "unable to resolve receiver sidecar path '{relative_path}'. Place the receiver runtime under receivers/AirPlayServer for development and bundle it for release. Searched: {searched_paths}"
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
            if matches!(
                guard.snapshot.status,
                SessionStatus::Mirroring | SessionStatus::Recording
            ) {
                guard.snapshot.status = SessionStatus::Connecting;
            }
            guard.receiver_runtime.transport = ReceiverTransport::Airplayserver;
            set_receiver_runtime_state(&mut guard, ReceiverRuntimeState::Ready);
        } else {
            guard.snapshot.status = SessionStatus::Idle;
            guard.active_session_id = None;
            guard.native_pairing_approved_for_session = false;
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
    let service_name = std::ffi::OsStr::new(SERVICE_NAME)
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();

    let manager = unsafe { OpenSCManagerW(std::ptr::null(), std::ptr::null(), SC_MANAGER_CONNECT) };
    if manager.is_null() {
        let error = unsafe { GetLastError() };
        return BonjourStatusSnapshot {
            status: BonjourStatusKind::Unknown,
            service_name: SERVICE_NAME.to_string(),
            detail: format!(
                "MirrorSim could not open Windows Service Control Manager (error {error}). If discovery fails, verify Bonjour is installed and running."
            ),
        };
    }

    let service = unsafe { OpenServiceW(manager, service_name.as_ptr(), SERVICE_QUERY_STATUS) };
    if service.is_null() {
        let error = unsafe { GetLastError() };
        unsafe { CloseServiceHandle(manager) };
        if error == ERROR_SERVICE_DOES_NOT_EXIST {
            return BonjourStatusSnapshot {
                status: BonjourStatusKind::Missing,
                service_name: SERVICE_NAME.to_string(),
                detail: String::from(
                    "Bonjour for Windows is not installed. Install it so your iPhone can discover this PC over AirPlay.",
                ),
            };
        }

        return BonjourStatusSnapshot {
            status: BonjourStatusKind::Unknown,
            service_name: SERVICE_NAME.to_string(),
            detail: format!(
                "MirrorSim could not open Bonjour Service (error {error}). If discovery fails, verify Bonjour is installed and running."
            ),
        };
    }

    let mut status = SERVICE_STATUS::default();
    let queried = unsafe { QueryServiceStatus(service, &mut status) };
    let error = if queried == 0 {
        Some(unsafe { GetLastError() })
    } else {
        None
    };
    unsafe {
        CloseServiceHandle(service);
        CloseServiceHandle(manager);
    }

    if let Some(error) = error {
        return BonjourStatusSnapshot {
            status: BonjourStatusKind::Unknown,
            service_name: SERVICE_NAME.to_string(),
            detail: format!(
                "MirrorSim could not query Bonjour Service (error {error}). If discovery fails, verify Bonjour is installed and running."
            ),
        };
    }

    if status.dwCurrentState == SERVICE_RUNNING {
        BonjourStatusSnapshot {
            status: BonjourStatusKind::Ready,
            service_name: SERVICE_NAME.to_string(),
            detail: String::from("Bonjour Service is installed and running."),
        }
    } else {
        BonjourStatusSnapshot {
            status: BonjourStatusKind::Stopped,
            service_name: SERVICE_NAME.to_string(),
            detail: String::from(
                "Bonjour Service is installed but not running. Start the service in Windows Services before using discovery.",
            ),
        }
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
    sidecar_generation: u64,
    event: SidecarEvent,
) -> CommandResult<()> {
    if !sidecar_generation_is_current(sidecar, sidecar_generation) {
        return Ok(());
    }

    if let SidecarEvent::VideoAccessUnit { stream_id, .. } = &event {
        let guard = store.lock().map_err(|error| error.to_string())?;
        if !session_accepts_media(&guard, stream_id) {
            return Ok(());
        }
    }

    // Base64 decoding is CPU-heavy for full-resolution access units. Do it
    // before taking the session-state mutex so UI snapshot commands are not
    // blocked behind decoding work on every video frame.
    let mut decoded_video_payload = match &event {
        SidecarEvent::VideoAccessUnit { payload_base64, .. } => {
            if payload_base64.len() > MAX_VIDEO_ACCESS_UNIT_BYTES.saturating_mul(2) {
                return Err(String::from(
                    "receiver video access unit exceeded the 8 MiB safety limit",
                ));
            }
            let payload = BASE64_STANDARD
                .decode(payload_base64.as_bytes())
                .map_err(|error| format!("failed to decode receiver payload: {error}"))?;
            if payload.len() > MAX_VIDEO_ACCESS_UNIT_BYTES {
                return Err(String::from(
                    "receiver video access unit exceeded the 8 MiB safety limit",
                ));
            }
            Some(payload)
        }
        _ => None,
    };

    let mut request_keyframe: Option<(String, String)> = None;
    let mut stop_session_request: Option<String> = None;
    let mut cancel_pairing_request: Option<(String, String)> = None;
    let mut restart_sidecar = false;
    let mut receiver_media_accepted = false;
    let mut connecting_watchdog: Option<(u64, String, String)> = None;
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
                if protocol_version != EXPECTED_RECEIVER_PROTOCOL_VERSION {
                    restart_sidecar = true;
                    guard.snapshot.status = SessionStatus::Idle;
                    guard.active_session_id = None;
                    guard.native_pairing_approved_for_session = false;
                    clear_session_identity(&mut guard);
                    clear_pairing(&mut guard);
                    reset_preview(&mut guard);
                    reset_fixture_transport(&mut guard);
                    set_receiver_runtime_state(&mut guard, ReceiverRuntimeState::Idle);
                    guard.receiver_runtime.last_error = Some(format!(
                        "receiver protocol mismatch: expected {EXPECTED_RECEIVER_PROTOCOL_VERSION}, received {protocol_version}"
                    ));
                    emit_snapshot = true;
                    emit_preview = true;
                    emit_preview_stream = true;
                } else {
                    guard.receiver_runtime.transport = ReceiverTransport::Airplayserver;
                    guard.snapshot.receiver_id = Some(receiver_id.clone());
                    guard.snapshot.receiver_protocol_version = Some(protocol_version.clone());
                    guard.snapshot.receiver_capabilities = capabilities.clone();
                    emit_snapshot = true;
                    set_receiver_runtime_state(&mut guard, ReceiverRuntimeState::Ready);
                    guard.receiver_runtime.last_error = None;
                }
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
                if guard.active_session_id.as_deref() != Some(session_id.as_str()) {
                    return Ok(());
                }
                guard.connection_attempt_generation =
                    guard.connection_attempt_generation.wrapping_add(1);
                let connection_attempt_generation = guard.connection_attempt_generation;
                let watchdog_session_id = session_id.clone();
                let watchdog_stream_id = stream_id.clone();
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
                if matches!(
                    guard.pairing.phase,
                    PairingPhase::Idle | PairingPhase::Paired | PairingPhase::Failed
                ) {
                    clear_pairing(&mut guard);
                }
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
                    stop_session_request = guard.active_session_id.take();
                    guard.require_local_session_approval = false;
                    guard.require_known_device = false;
                    guard.pending_local_session_approval = false;
                    guard.native_pairing_approved_for_session = false;
                    guard.snapshot.status = SessionStatus::Idle;
                    reset_preview(&mut guard);
                    reset_fixture_transport(&mut guard);
                    guard.receiver_runtime.last_error = guard.pairing.failure_message.clone();
                    emit_pairing = true;
                    (
                        String::from("warning"),
                        format!(
                            "{device_name} was rejected because this iPhone is blocked on this PC."
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
                    stop_session_request = guard.active_session_id.take();
                    guard.require_local_session_approval = false;
                    guard.require_known_device = false;
                    guard.pending_local_session_approval = false;
                    guard.native_pairing_approved_for_session = false;
                    guard.snapshot.status = SessionStatus::Idle;
                    reset_preview(&mut guard);
                    reset_fixture_transport(&mut guard);
                    guard.receiver_runtime.last_error = guard.pairing.failure_message.clone();
                    emit_pairing = true;
                    (
                        String::from("warning"),
                        format!(
                            "{device_name} was rejected because it is not known on this PC yet."
                        ),
                    )
                } else if needs_local_session_approval(&guard) {
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
                        format!("{device_name} connected and is waiting for local approval."),
                    )
                } else {
                    guard.receiver_runtime.last_error = Some(String::from(
                        "receiver connected; waiting for the first H.264 frame from the iPhone",
                    ));
                    emit_pairing = true;
                    (
                        String::from("success"),
                        format!("{device_name} connected to MirrorSim."),
                    )
                };

                emit_snapshot = true;
                emit_preview_stream = true;

                if guard.active_session_id.as_deref() == Some(watchdog_session_id.as_str())
                    && matches!(guard.snapshot.status, SessionStatus::Connecting)
                {
                    connecting_watchdog = Some((
                        connection_attempt_generation,
                        watchdog_session_id,
                        watchdog_stream_id,
                    ));
                }

                history_entries.push(ConnectionHistoryEntry {
                    id: String::new(),
                    occurred_at: now_unix_timestamp(),
                    event: String::from("session-started"),
                    status: history_status,
                    message: history_message,
                    device_name: Some(device_name),
                    device_id,
                    device_model,
                    device_os_name,
                    device_os_version,
                    device_key: guard.snapshot.current_device_key.clone(),
                    receiver_name: guard.snapshot.receiver_id.clone(),
                });
            }
            SidecarEvent::PairingStateChanged {
                phase,
                entry_mode,
                session_id,
                challenge_id,
                device_name,
                device_id,
                display_pin,
                prompt,
                failure_message,
                can_trust,
            } => {
                if validate_pairing_event_correlation(
                    &guard,
                    phase,
                    Some(session_id.as_str()),
                    Some(challenge_id.as_str()),
                )? != PairingEventCorrelation::Accept
                {
                    return Ok(());
                }
                let awaiting_trust_confirmation = guard.pairing.can_trust
                    || matches!(guard.pairing.phase, PairingPhase::AwaitingTrust);

                guard.pairing.session_id = Some(session_id.clone());
                guard.pairing.challenge_id = Some(challenge_id.clone());

                if let Some(device_name) = device_name {
                    guard.snapshot.device_name = device_name.clone();
                    guard.pairing.device_name = Some(device_name);
                    emit_snapshot = true;
                }

                if let Some(device_id) = device_id {
                    guard.snapshot.current_device_id = Some(device_id.clone());
                    guard.pairing.device_id = Some(device_id);
                    emit_snapshot = true;
                }

                if emit_snapshot {
                    let trusted_devices = get_trusted_devices(app)?;
                    apply_current_device_trust(&mut guard.snapshot, &trusted_devices);
                }

                let policy_rejection = pairing_policy_rejection(&guard);

                let pairing_was_policy_rejected = policy_rejection.is_some();
                if let Some(rejection) = policy_rejection {
                    if !matches!(phase, PairingPhase::Idle) {
                        guard.pairing.phase = PairingPhase::Failed;
                        guard.pairing.entry_mode = crate::models::PairingEntryMode::ConfirmOnly;
                        guard.pairing.display_pin = None;
                        guard.pairing.prompt = None;
                        guard.pairing.failure_message = Some(rejection.clone());
                        guard.pairing.can_trust = false;
                        guard.receiver_runtime.last_error = Some(rejection.clone());

                        if can_trust
                            || matches!(
                                phase,
                                PairingPhase::PinRequired | PairingPhase::AwaitingTrust
                            )
                        {
                            cancel_pairing_request = guard
                                .pairing
                                .session_id
                                .clone()
                                .zip(guard.pairing.challenge_id.clone());
                        }

                        history_entries.push(ConnectionHistoryEntry {
                            id: String::new(),
                            occurred_at: now_unix_timestamp(),
                            event: String::from("pairing-policy-rejected"),
                            status: String::from("error"),
                            message: rejection,
                            device_name: Some(guard.snapshot.device_name.clone()),
                            device_id: guard.snapshot.current_device_id.clone(),
                            device_model: guard.snapshot.current_device_model.clone(),
                            device_os_name: guard.snapshot.current_device_os_name.clone(),
                            device_os_version: guard.snapshot.current_device_os_version.clone(),
                            device_key: guard.snapshot.current_device_key.clone(),
                            receiver_name: guard.snapshot.receiver_id.clone(),
                        });
                    } else {
                        guard.pairing.phase = PairingPhase::Failed;
                        guard.pairing.entry_mode = crate::models::PairingEntryMode::ConfirmOnly;
                        guard.pairing.display_pin = None;
                        guard.pairing.prompt = None;
                        guard.pairing.failure_message = Some(rejection);
                        guard.pairing.can_trust = false;
                    }
                } else {
                    guard.pairing.phase = phase;
                    guard.pairing.entry_mode = entry_mode;
                    guard.pairing.display_pin = display_pin;
                    guard.pairing.prompt = prompt;
                    guard.pairing.failure_message = failure_message;
                    guard.pairing.can_trust = can_trust;

                    if guard.snapshot.current_device_key.is_some() {
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
                }

                if pairing_was_policy_rejected
                    || matches!(
                        phase,
                        PairingPhase::Idle | PairingPhase::Paired | PairingPhase::Failed
                    )
                {
                    mark_pairing_challenge_closed(&mut guard, &session_id, &challenge_id);
                }

                emit_pairing = true;
            }
            SidecarEvent::VideoAccessUnit {
                stream_id,
                sample_index,
                keyframe,
                pts,
                dts,
                duration,
                payload_base64: _,
            } => {
                if !session_accepts_media(&guard, &stream_id) {
                    return Ok(());
                }

                let waiting_for_local_approval = guard.pending_local_session_approval;
                let previous_sample_index = guard.preview_diagnostics.last_access_unit_index;
                let sample_index_restarted =
                    media_timeline_restarted(previous_sample_index, sample_index);
                let needs_decoder_recovery = guard.receiver_runtime.stream_id == stream_id
                    && guard.receiver_runtime.transport == ReceiverTransport::Airplayserver
                    && sample_index_restarted;

                if needs_decoder_recovery {
                    prepare_live_transport(&mut guard, stream_id.clone());
                    guard.remux_blueprint.reset_live_preview(stream_id.clone());
                    guard.receiver_runtime.state = ReceiverRuntimeState::Ready;
                    guard.receiver_runtime.queued_segments = 0;
                    guard.receiver_runtime.last_error = Some(String::from(
                        "stream timeline restarted; waiting for a fresh keyframe",
                    ));
                    reset_preview(&mut guard);
                    emit_preview = true;
                    emit_preview_stream = true;

                    if receiver_supports_keyframe_request(&guard.snapshot.receiver_capabilities) {
                        request_keyframe =
                            Some((stream_id.clone(), String::from("stream timeline restarted")));
                    }
                }

                let payload = decoded_video_payload.take().ok_or_else(|| {
                    String::from("receiver video access unit payload was unavailable")
                })?;
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
                receiver_media_accepted = push_result.sample_enqueued;
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
                    let normalized_duration = normalize_preview_sample_duration(duration);
                    guard.preview.fps =
                        preview_fps_from_duration(normalized_duration, preview_timescale);
                    guard.preview.bitrate_kbps =
                        preview_bitrate_kbps(size_bytes, normalized_duration, preview_timescale);
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
                if guard.active_session_id.is_none()
                    || matches!(
                        guard.snapshot.status,
                        SessionStatus::Idle | SessionStatus::Discovering
                    )
                    || guard.receiver_runtime.stream_id != stream_id
                {
                    return Ok(());
                }
                let disconnected_device_name = guard.snapshot.device_name.clone();
                let disconnected_device_id = guard.snapshot.current_device_id.clone();
                let disconnected_device_model = guard.snapshot.current_device_model.clone();
                let disconnected_device_os_name = guard.snapshot.current_device_os_name.clone();
                let disconnected_device_os_version =
                    guard.snapshot.current_device_os_version.clone();
                let disconnected_device_key = guard.snapshot.current_device_key.clone();
                let session_stopped = reason == "session_stopped";
                let sender_disconnected = reason == "sender_disconnected";
                let should_resume_listening = session_stopped || sender_disconnected;

                if should_resume_listening {
                    resume_listening_after_disconnect(&mut guard, stream_id.clone());
                    emit_snapshot = true;
                    emit_preview = true;
                    emit_preview_stream = true;
                    emit_pairing = true;
                } else {
                    prepare_live_transport(&mut guard, stream_id.clone());
                    guard.remux_blueprint.reset_live_preview(stream_id.clone());
                    guard.receiver_runtime.state = ReceiverRuntimeState::Ready;
                    guard.receiver_runtime.queued_segments = 0;
                    guard.receiver_runtime.last_error =
                        Some(format!("stream discontinuity: {reason}"));

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

                        let can_request_keyframe = receiver_supports_keyframe_request(
                            &guard.snapshot.receiver_capabilities,
                        );
                        if can_request_keyframe {
                            request_keyframe = Some((stream_id, reason.clone()));
                        } else {
                            stop_session_request = guard.active_session_id.take();
                            restart_sidecar = true;
                            guard.require_local_session_approval = false;
                            guard.require_known_device = false;
                            guard.pending_local_session_approval = false;
                            guard.native_pairing_approved_for_session = false;
                            guard.snapshot.status = SessionStatus::Idle;
                            clear_pairing(&mut guard);
                            reset_fixture_transport(&mut guard);
                            set_receiver_runtime_state(&mut guard, ReceiverRuntimeState::Idle);
                            guard.receiver_runtime.last_error = Some(format!(
                                "receiver lost the AirPlay stream and restarted: {reason}"
                            ));
                            emit_snapshot = true;
                        }
                    }
                }

                history_entries.push(ConnectionHistoryEntry {
                    id: String::new(),
                    occurred_at: now_unix_timestamp(),
                    event: String::from("stream-discontinuity"),
                    status: if should_resume_listening {
                        String::from("info")
                    } else {
                        String::from("warning")
                    },
                    message: if should_resume_listening {
                        format!(
                            "{disconnected_device_name} disconnected. MirrorSim is listening for another iPhone connection."
                        )
                    } else {
                        format!("Stream discontinuity: {reason}")
                    },
                    device_name: Some(disconnected_device_name),
                    device_id: disconnected_device_id,
                    device_model: disconnected_device_model,
                    device_os_name: disconnected_device_os_name,
                    device_os_version: disconnected_device_os_version,
                    device_key: disconnected_device_key,
                    receiver_name: guard.snapshot.receiver_id.clone(),
                });

                sync_preview_diagnostics(&mut guard);
            }
            SidecarEvent::ReceiverError {
                code,
                message,
                recoverable,
            } => {
                if guard.active_session_id.is_none() {
                    return Ok(());
                }
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
                        message: format!("{code}: {message}"),
                        device_name: Some(snapshot.device_name),
                        device_id: snapshot.current_device_id,
                        device_model: snapshot.current_device_model,
                        device_os_name: snapshot.current_device_os_name,
                        device_os_version: snapshot.current_device_os_version,
                        device_key: snapshot.current_device_key,
                        receiver_name: snapshot.receiver_id,
                    },
                );

                let result =
                    emit_runtime_error(app, store, format!("{code}: {message}"), recoverable);
                if !recoverable {
                    stop_sidecar_runtime(sidecar);
                }
                return result;
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

    if receiver_media_accepted {
        if let Ok(mut sidecar_guard) = sidecar.lock() {
            if let Some(runtime) = sidecar_guard
                .as_mut()
                .filter(|runtime| runtime.generation == sidecar_generation)
            {
                if should_reset_sidecar_restart_budget(
                    runtime.restart_attempt,
                    runtime.started_at.elapsed(),
                    true,
                ) {
                    runtime.restart_attempt = 0;
                }
            }
        }
    }

    let mut action_errors = Vec::new();
    if let Some((stream_id, reason)) = request_keyframe {
        if let Err(error) = send_sidecar_command(
            sidecar,
            json!({
                "name": "request_keyframe",
                "stream_id": stream_id,
                "reason": reason,
            }),
        ) {
            action_errors.push(format!("could not request a recovery keyframe: {error}"));
        }
    }

    if let Some(session_id) = stop_session_request {
        if let Err(error) = send_sidecar_command(
            sidecar,
            json!({
                "name": "stop_session",
                "session_id": session_id,
            }),
        ) {
            action_errors.push(format!(
                "could not stop the failed receiver session: {error}"
            ));
        }
    }

    if let Some((session_id, challenge_id)) = cancel_pairing_request {
        if let Err(error) = send_sidecar_command(
            sidecar,
            json!({
                "name": "cancel_pairing",
                "session_id": session_id,
                "challenge_id": challenge_id,
            }),
        ) {
            action_errors.push(format!(
                "could not cancel the rejected pairing request: {error}"
            ));
        }
    }

    if restart_sidecar {
        stop_sidecar_runtime(sidecar);
    }

    for entry in history_entries {
        if let Err(error) = append_history_entry(app, entry) {
            eprintln!("[MirrorSim history] could not persist receiver event: {error}");
        }
    }

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

    if let Some((connection_attempt_generation, session_id, stream_id)) = connecting_watchdog {
        spawn_connecting_watchdog(
            app.clone(),
            store.clone(),
            sidecar.clone(),
            sidecar_generation,
            connection_attempt_generation,
            session_id,
            stream_id,
        );
    }

    if !action_errors.is_empty() {
        return Err(action_errors.join("; "));
    }

    Ok(())
}

fn spawn_connecting_watchdog(
    app: AppHandle,
    store: Arc<Mutex<SessionStore>>,
    sidecar: Arc<Mutex<Option<SidecarRuntime>>>,
    sidecar_generation: u64,
    connection_attempt_generation: u64,
    session_id: String,
    stream_id: String,
) {
    thread::spawn(move || {
        let mut waiting_for_media_since: Option<Instant> = None;

        loop {
            thread::sleep(CONNECTING_WATCHDOG_INTERVAL);

            if !sidecar_generation_is_current(&sidecar, sidecar_generation) {
                return;
            }

            let watchdog_state = match store.lock() {
                Ok(guard) => connecting_watchdog_state(
                    &guard,
                    connection_attempt_generation,
                    &session_id,
                    &stream_id,
                ),
                Err(_) => return,
            };

            match watchdog_state {
                ConnectingWatchdogState::Stop => return,
                ConnectingWatchdogState::WaitingForApproval | ConnectingWatchdogState::Healthy => {
                    waiting_for_media_since = None;
                    continue;
                }
                ConnectingWatchdogState::WaitingForMedia => {
                    let started_at = waiting_for_media_since.get_or_insert_with(Instant::now);
                    if started_at.elapsed() < CONNECTING_MEDIA_TIMEOUT {
                        continue;
                    }
                }
            }

            let recovery = match store.lock() {
                Ok(mut guard)
                    if connecting_watchdog_state(
                        &guard,
                        connection_attempt_generation,
                        &session_id,
                        &stream_id,
                    ) == ConnectingWatchdogState::WaitingForMedia =>
                {
                    let history_entry = ConnectionHistoryEntry {
                        id: String::new(),
                        occurred_at: now_unix_timestamp(),
                        event: String::from("connection-timeout"),
                        status: String::from("warning"),
                        message: format!(
                            "{} stopped before sending a decodable video frame. MirrorSim reset the receiver and resumed listening.",
                            guard.snapshot.device_name
                        ),
                        device_name: Some(guard.snapshot.device_name.clone()),
                        device_id: guard.snapshot.current_device_id.clone(),
                        device_model: guard.snapshot.current_device_model.clone(),
                        device_os_name: guard.snapshot.current_device_os_name.clone(),
                        device_os_version: guard.snapshot.current_device_os_version.clone(),
                        device_key: guard.snapshot.current_device_key.clone(),
                        receiver_name: guard.snapshot.receiver_id.clone(),
                    };

                    guard.connection_attempt_generation =
                        guard.connection_attempt_generation.wrapping_add(1);
                    resume_listening_after_disconnect(&mut guard, stream_id.clone());

                    Some((
                        guard.snapshot.clone(),
                        guard.preview.clone(),
                        guard.preview_stream.clone(),
                        guard.receiver_runtime.clone(),
                        guard.preview_diagnostics.clone(),
                        guard.pairing.clone(),
                        history_entry,
                    ))
                }
                _ => None,
            };

            let Some((
                snapshot,
                preview,
                preview_stream,
                receiver_runtime,
                preview_diagnostics,
                pairing,
                history_entry,
            )) = recovery
            else {
                return;
            };

            let _ = emit_state_updates(
                &app,
                Some(snapshot),
                Some(preview),
                Some(preview_stream),
                Some(receiver_runtime),
                Some(preview_diagnostics),
            );
            let _ = emit_pairing_status(&app, &pairing);
            if let Err(error) = append_history_entry(&app, history_entry) {
                eprintln!("[MirrorSim history] could not persist connection timeout: {error}");
            }

            let restart_command = match sidecar.lock() {
                Ok(guard) => guard
                    .as_ref()
                    .filter(|runtime| runtime.generation == sidecar_generation)
                    .and_then(|runtime| runtime.restart_command.clone()),
                Err(_) => None,
            };

            let session_is_still_active = store.lock().is_ok_and(|guard| {
                guard.active_session_id.as_deref() == Some(session_id.as_str())
                    && matches!(guard.snapshot.status, SessionStatus::Discovering)
            });

            if session_is_still_active {
                if let Some(start_command) = restart_command {
                    let reset_result = send_sidecar_command(
                        &sidecar,
                        json!({
                            "name": "stop_session",
                            "session_id": session_id,
                        }),
                    )
                    .and_then(|_| {
                        let should_restart = store.lock().is_ok_and(|guard| {
                            guard.active_session_id.as_deref() == Some(session_id.as_str())
                                && matches!(guard.snapshot.status, SessionStatus::Discovering)
                        });
                        if should_restart {
                            send_sidecar_command(&sidecar, start_command)
                        } else {
                            Ok(())
                        }
                    });

                    if let Err(error) = reset_result {
                        let _ = emit_runtime_error(
                            &app,
                            &store,
                            format!("could not reset a stalled iPhone connection: {error}"),
                            true,
                        );
                    }
                }
            }

            return;
        }
    });
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
    next_sidecar_generation: Arc<AtomicU64>,
    sidecar_generation: u64,
    stdout: ChildStdout,
) {
    thread::spawn(move || {
        let mut reader = BufReader::new(stdout);

        loop {
            let line = match read_bounded_line(&mut reader, MAX_RECEIVER_EVENT_LINE_BYTES) {
                Ok(Some(line)) => line,
                Ok(None) => break,
                Err(error) => {
                    if sidecar_generation_is_current(&sidecar, sidecar_generation) {
                        let _ = emit_runtime_error(
                            &app,
                            &store,
                            format!("receiver output error: {error}"),
                            true,
                        );
                    }
                    break;
                }
            };

            if line.trim().is_empty() {
                continue;
            }

            match serde_json::from_str::<SidecarEvent>(&line) {
                Ok(event) => {
                    if let Err(error) =
                        handle_sidecar_event(&app, &store, &sidecar, sidecar_generation, event)
                    {
                        if sidecar_generation_is_current(&sidecar, sidecar_generation) {
                            let _ = emit_runtime_error(
                                &app,
                                &store,
                                format!("receiver event failed: {error}"),
                                true,
                            );
                        }
                    }
                }
                Err(error) => {
                    if sidecar_generation_is_current(&sidecar, sidecar_generation) {
                        let _ = emit_runtime_error(
                            &app,
                            &store,
                            format!("receiver emitted malformed event: {error}"),
                            true,
                        );
                    }
                }
            }
        }

        let restart_plan = if let Ok(mut guard) = sidecar.lock() {
            if guard
                .as_ref()
                .is_some_and(|runtime| runtime.generation == sidecar_generation)
            {
                let restart_plan = guard.as_ref().and_then(|runtime| {
                    runtime
                        .restart_command
                        .clone()
                        .map(|command| (command, runtime.restart_attempt))
                });
                *guard = None;
                Some(restart_plan)
            } else {
                None
            }
        } else {
            None
        };

        let Some(restart_plan) = restart_plan else {
            return;
        };

        let is_idle = match store.lock() {
            Ok(guard) => guard.snapshot.status == SessionStatus::Idle,
            Err(_) => true,
        };

        if is_idle {
            return;
        }

        if let Some((restart_command, restart_attempt)) = restart_plan {
            let spec = ReceiverSidecarSpec::direct_receiver_boundary();
            if spec.launch.restart_on_crash && restart_attempt < MAX_SIDECAR_RESTART_ATTEMPTS {
                let next_attempt = restart_attempt + 1;
                let backoff_ms = 250_u64 * (1_u64 << restart_attempt);
                thread::sleep(std::time::Duration::from_millis(backoff_ms));

                match launch_sidecar_runtime(
                    &app,
                    &store,
                    &sidecar,
                    &next_sidecar_generation,
                    Some(restart_command),
                    next_attempt,
                ) {
                    Ok(_) => return,
                    Err(error) => {
                        eprintln!(
                            "[MirrorSim receiver] restart attempt {next_attempt} failed: {error}"
                        );
                    }
                }
            }
        }

        let _ = emit_runtime_error(
            &app,
            &store,
            String::from("receiver sidecar exited unexpectedly and could not be restarted"),
            false,
        );
    });
}

fn read_bounded_line<R: BufRead>(
    reader: &mut R,
    max_bytes: usize,
) -> std::io::Result<Option<String>> {
    let mut bytes = Vec::new();
    let mut exceeded = false;

    loop {
        let available = reader.fill_buf()?;
        if available.is_empty() {
            if exceeded {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::InvalidData,
                    "receiver event exceeded the maximum line size",
                ));
            }
            if bytes.is_empty() {
                return Ok(None);
            }
            return String::from_utf8(bytes)
                .map(Some)
                .map_err(|error| std::io::Error::new(std::io::ErrorKind::InvalidData, error));
        }

        let newline = available.iter().position(|byte| *byte == b'\n');
        let consumed = newline.map_or(available.len(), |index| index + 1);
        let content_len = newline.unwrap_or(consumed);
        if !exceeded {
            if bytes.len() + content_len > max_bytes {
                exceeded = true;
            } else {
                bytes.extend_from_slice(&available[..content_len]);
            }
        }
        reader.consume(consumed);

        if newline.is_some() {
            if exceeded {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::InvalidData,
                    "receiver event exceeded the maximum line size",
                ));
            }
            return String::from_utf8(bytes)
                .map(Some)
                .map_err(|error| std::io::Error::new(std::io::ErrorKind::InvalidData, error));
        }
    }
}

fn spawn_sidecar_stderr_loop(stderr: ChildStderr, store: Arc<Mutex<SessionStore>>) {
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

            eprintln!("[MirrorSim receiver] {trimmed}");
            if let Ok(mut guard) = store.lock() {
                let retained = trimmed
                    .chars()
                    .take(MAX_RETAINED_SIDECAR_LOG_CHARS)
                    .collect::<String>();
                guard
                    .sidecar_logs
                    .push_back(format!("[{}] {}", now_unix_timestamp(), retained));
                while guard.sidecar_logs.len() > MAX_RETAINED_SIDECAR_LOG_LINES {
                    guard.sidecar_logs.pop_front();
                }
            }
        }
    });
}

fn launch_sidecar_runtime(
    app: &AppHandle,
    store: &Arc<Mutex<SessionStore>>,
    sidecar: &Arc<Mutex<Option<SidecarRuntime>>>,
    next_sidecar_generation: &Arc<AtomicU64>,
    restart_command: Option<serde_json::Value>,
    restart_attempt: u8,
) -> CommandResult<bool> {
    let mut sidecar_guard = sidecar.lock().map_err(|error| error.to_string())?;
    if sidecar_guard.is_some() {
        return Ok(false);
    }

    let spec = ReceiverSidecarSpec::direct_receiver_boundary();
    let sidecar_generation = next_sidecar_generation.fetch_add(1, Ordering::Relaxed);
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

    *sidecar_guard = Some(SidecarRuntime {
        generation: sidecar_generation,
        child,
        stdin,
        restart_command: None,
        restart_attempt,
        started_at: Instant::now(),
        #[cfg(windows)]
        _job: sidecar_job,
    });

    drop(sidecar_guard);

    spawn_sidecar_stdout_loop(
        app.clone(),
        store.clone(),
        sidecar.clone(),
        next_sidecar_generation.clone(),
        sidecar_generation,
        stdout,
    );
    spawn_sidecar_stderr_loop(stderr, store.clone());

    if let Some(command) = restart_command {
        if let Err(error) = send_sidecar_command(sidecar, command) {
            stop_sidecar_runtime(sidecar);
            return Err(format!(
                "could not restore receiver session after restart: {error}"
            ));
        }
    }

    Ok(true)
}

pub(crate) fn ensure_sidecar_runtime(app: &AppHandle, state: &AppState) -> CommandResult<bool> {
    launch_sidecar_runtime(
        app,
        &state.inner,
        &state.sidecar,
        &state.next_sidecar_generation,
        None,
        0,
    )
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

pub(crate) fn stop_sidecar_runtime(sidecar: &Arc<Mutex<Option<SidecarRuntime>>>) {
    if let Ok(mut guard) = sidecar.lock() {
        let _ = guard.take();
    }
}

pub(crate) fn ensure_bonjour_ready() -> CommandResult<()> {
    let bonjour = query_bonjour_status();
    if let Some(message) = bonjour_blocking_message(&bonjour) {
        return Err(message);
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{
        connecting_watchdog_state, media_timeline_restarted, needs_local_session_approval,
        pairing_policy_rejection, read_bounded_line, session_accepts_media,
        should_reset_sidecar_restart_budget, validate_pairing_event_correlation,
        ConnectingWatchdogState, PairingEventCorrelation, SIDECAR_RESTART_STABILITY_WINDOW,
    };
    use crate::models::{PairingPhase, SessionStatus};
    use crate::state::{mark_pairing_challenge_closed, prepare_live_transport, SessionStore};
    use std::time::Duration;

    fn connected_store() -> SessionStore {
        let mut store = SessionStore {
            active_session_id: Some(String::from("session-1")),
            ..SessionStore::default()
        };
        store.snapshot.status = SessionStatus::Connecting;
        prepare_live_transport(&mut store, String::from("stream-1"));
        store
    }

    #[test]
    fn stopped_session_rejects_late_media() {
        let mut store = connected_store();
        store.active_session_id = None;
        store.snapshot.status = SessionStatus::Idle;

        assert!(!session_accepts_media(&store, "stream-1"));
    }

    #[test]
    fn media_requires_the_active_stream_id() {
        let store = connected_store();

        assert!(session_accepts_media(&store, "stream-1"));
        assert!(!session_accepts_media(&store, "stale-stream"));
    }

    #[test]
    fn media_timeline_recovery_uses_sequence_resets_not_timestamp_gaps() {
        assert!(!media_timeline_restarted(Some(40), 41));
        assert!(media_timeline_restarted(Some(40), 0));
        assert!(media_timeline_restarted(Some(40), 40));
    }

    #[test]
    fn connecting_watchdog_is_correlated_and_pauses_for_approval() {
        let mut store = connected_store();
        store.connection_attempt_generation = 7;

        assert_eq!(
            connecting_watchdog_state(&store, 7, "session-1", "stream-1"),
            ConnectingWatchdogState::WaitingForMedia
        );

        store.pending_local_session_approval = true;
        assert_eq!(
            connecting_watchdog_state(&store, 7, "session-1", "stream-1"),
            ConnectingWatchdogState::WaitingForApproval
        );

        store.pending_local_session_approval = false;
        store.snapshot.status = SessionStatus::Mirroring;
        assert_eq!(
            connecting_watchdog_state(&store, 7, "session-1", "stream-1"),
            ConnectingWatchdogState::Healthy
        );

        assert_eq!(
            connecting_watchdog_state(&store, 6, "session-1", "stream-1"),
            ConnectingWatchdogState::Stop
        );
        assert_eq!(
            connecting_watchdog_state(&store, 7, "stale-session", "stream-1"),
            ConnectingWatchdogState::Stop
        );
    }

    #[test]
    fn blocked_and_unknown_only_sessions_reject_media() {
        let mut store = connected_store();
        store.snapshot.current_device_blocked = true;
        assert!(!session_accepts_media(&store, "stream-1"));

        store.snapshot.current_device_blocked = false;
        store.require_known_device = true;
        store.snapshot.current_device_known = false;
        assert!(!session_accepts_media(&store, "stream-1"));
    }

    #[test]
    fn native_pairing_approval_prevents_a_second_ask_mode_prompt() {
        let mut store = connected_store();
        store.require_local_session_approval = true;
        store.snapshot.current_device_trusted = false;
        assert!(needs_local_session_approval(&store));

        store.native_pairing_approved_for_session = true;
        assert!(!needs_local_session_approval(&store));
    }

    #[test]
    fn pairing_policy_rejects_blocked_and_unknown_devices() {
        let mut store = connected_store();
        store.snapshot.current_device_key = Some(String::from("phone-1"));
        store.snapshot.current_device_blocked = true;
        store.snapshot.current_device_blocked_reason = Some(String::from("Blocked by owner"));
        assert_eq!(
            pairing_policy_rejection(&store).as_deref(),
            Some("Blocked by owner")
        );

        store.snapshot.current_device_blocked = false;
        store.snapshot.current_device_blocked_reason = None;
        store.require_known_device = true;
        store.snapshot.current_device_known = false;
        assert!(pairing_policy_rejection(&store)
            .as_deref()
            .is_some_and(|message| message.contains("not known")));

        store.snapshot.current_device_known = true;
        assert!(pairing_policy_rejection(&store).is_none());
    }

    #[test]
    fn every_pairing_phase_requires_both_correlation_ids() {
        let store = connected_store();
        for (session_id, challenge_id) in [
            (None, Some("challenge-1")),
            (Some(""), Some("challenge-1")),
            (Some("session-1"), None),
            (Some("session-1"), Some("   ")),
        ] {
            assert!(validate_pairing_event_correlation(
                &store,
                PairingPhase::AwaitingTrust,
                session_id,
                challenge_id,
            )
            .is_err());
        }
        assert!(validate_pairing_event_correlation(
            &store,
            PairingPhase::Idle,
            Some("session-1"),
            None,
        )
        .is_err());
    }

    #[test]
    fn pairing_event_correlation_ignores_stale_sessions_and_rejects_mismatched_challenges() {
        let mut store = connected_store();
        store.pairing.phase = PairingPhase::AwaitingTrust;
        store.pairing.session_id = Some(String::from("session-1"));
        store.pairing.challenge_id = Some(String::from("challenge-1"));

        assert_eq!(
            validate_pairing_event_correlation(
                &store,
                PairingPhase::AwaitingTrust,
                Some("session-1"),
                Some("challenge-1"),
            )
            .expect("current event"),
            PairingEventCorrelation::Accept
        );
        assert_eq!(
            validate_pairing_event_correlation(
                &store,
                PairingPhase::AwaitingTrust,
                Some("stale-session"),
                Some("challenge-1"),
            )
            .expect("stale event"),
            PairingEventCorrelation::IgnoreStale
        );
        assert!(validate_pairing_event_correlation(
            &store,
            PairingPhase::Verifying,
            Some("session-1"),
            Some("different-challenge"),
        )
        .is_err());
    }

    #[test]
    fn closed_pairing_challenge_replays_are_ignored() {
        let mut store = connected_store();
        mark_pairing_challenge_closed(&mut store, "session-1", "challenge-1");

        assert_eq!(
            validate_pairing_event_correlation(
                &store,
                PairingPhase::Failed,
                Some("session-1"),
                Some("challenge-1"),
            )
            .expect("closed challenge replay"),
            PairingEventCorrelation::IgnoreClosedReplay
        );
    }

    #[test]
    fn legitimate_verifying_and_paired_sequence_keeps_one_challenge() {
        let mut store = connected_store();
        assert_eq!(
            validate_pairing_event_correlation(
                &store,
                PairingPhase::AwaitingTrust,
                Some("session-1"),
                Some("challenge-1"),
            )
            .expect("new challenge"),
            PairingEventCorrelation::Accept
        );

        store.pairing.phase = PairingPhase::AwaitingTrust;
        store.pairing.session_id = Some(String::from("session-1"));
        store.pairing.challenge_id = Some(String::from("challenge-1"));
        for phase in [PairingPhase::Verifying, PairingPhase::Paired] {
            assert_eq!(
                validate_pairing_event_correlation(
                    &store,
                    phase,
                    Some("session-1"),
                    Some("challenge-1"),
                )
                .expect("continued challenge"),
                PairingEventCorrelation::Accept
            );
            store.pairing.phase = phase;
        }

        assert_eq!(
            validate_pairing_event_correlation(
                &store,
                PairingPhase::Verifying,
                Some("session-1"),
                Some("challenge-2"),
            )
            .expect("new challenge after terminal state"),
            PairingEventCorrelation::Accept
        );
    }

    #[test]
    fn idle_pairing_event_must_correlate_to_the_current_challenge() {
        let mut store = connected_store();
        store.pairing.phase = PairingPhase::AwaitingTrust;
        store.pairing.session_id = Some(String::from("session-1"));
        store.pairing.challenge_id = Some(String::from("challenge-1"));

        assert_eq!(
            validate_pairing_event_correlation(
                &store,
                PairingPhase::Idle,
                Some("session-1"),
                Some("challenge-1"),
            )
            .expect("correlated idle event"),
            PairingEventCorrelation::Accept
        );
        assert!(validate_pairing_event_correlation(
            &store,
            PairingPhase::Idle,
            Some("session-1"),
            Some("different-challenge"),
        )
        .is_err());
    }

    #[test]
    fn restart_budget_resets_only_after_stable_media() {
        assert!(!should_reset_sidecar_restart_budget(
            1,
            SIDECAR_RESTART_STABILITY_WINDOW,
            false,
        ));
        assert!(!should_reset_sidecar_restart_budget(
            1,
            SIDECAR_RESTART_STABILITY_WINDOW - Duration::from_millis(1),
            true,
        ));
        assert!(should_reset_sidecar_restart_budget(
            1,
            SIDECAR_RESTART_STABILITY_WINDOW,
            true,
        ));
        assert!(!should_reset_sidecar_restart_budget(
            0,
            SIDECAR_RESTART_STABILITY_WINDOW,
            true,
        ));
    }

    #[test]
    fn receiver_lines_are_bounded_and_consumed() {
        let mut reader = std::io::Cursor::new(b"123456\nok\n".to_vec());
        assert!(read_bounded_line(&mut reader, 4).is_err());
        assert_eq!(
            read_bounded_line(&mut reader, 4).expect("next line"),
            Some(String::from("ok"))
        );
        assert_eq!(read_bounded_line(&mut reader, 4).expect("eof"), None);
    }
}
