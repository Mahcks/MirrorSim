use serde::Serialize;
use std::{
    sync::{Arc, Mutex},
    thread,
    time::Duration,
};
use tauri::{AppHandle, Emitter, State};

const SESSION_STATUS_EVENT: &str = "session-status";
const PREVIEW_TELEMETRY_EVENT: &str = "preview-telemetry";

#[derive(Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
enum SessionStatus {
    Idle,
    Discovering,
    Connecting,
    Mirroring,
    Recording,
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

struct SessionStore {
    sequence: u64,
    snapshot: SessionSnapshot,
    preview: PreviewTelemetry,
}

struct AppState {
    inner: Arc<Mutex<SessionStore>>,
}

impl Default for AppState {
    fn default() -> Self {
        Self {
            inner: Arc::new(Mutex::new(SessionStore {
                sequence: 0,
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
            })),
        }
    }
}

type CommandResult<T> = Result<T, String>;

fn emit_session_status(app: &AppHandle, snapshot: &SessionSnapshot) -> CommandResult<()> {
    app.emit(SESSION_STATUS_EVENT, snapshot.clone())
        .map_err(|error| error.to_string())
}

fn emit_preview_telemetry(app: &AppHandle, preview: &PreviewTelemetry) -> CommandResult<()> {
    app.emit(PREVIEW_TELEMETRY_EVENT, preview.clone())
        .map_err(|error| error.to_string())
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

fn schedule_preview_stream(app: AppHandle, store: Arc<Mutex<SessionStore>>, sequence: u64) {
    thread::spawn(move || loop {
        thread::sleep(Duration::from_millis(250));

        let preview = {
            let mut guard = match store.lock() {
                Ok(guard) => guard,
                Err(_) => return,
            };

            if guard.sequence != sequence {
                return;
            }

            if !matches!(guard.snapshot.status, SessionStatus::Mirroring | SessionStatus::Recording) {
                return;
            }

            guard.preview.frame_number += 1;
            guard.preview.fps = if guard.snapshot.status == SessionStatus::Recording { 59 } else { 60 };
            guard.preview.bitrate_kbps = 6800 + ((guard.preview.frame_number % 6) as u32 * 235);
            guard.preview.latency_ms = 24 + ((guard.preview.frame_number % 5) as u16 * 3);
            guard.preview.activity = ((guard.preview.frame_number % 8) as f32 + 2.0) / 10.0;
            guard.preview.clone()
        };

        let _ = emit_preview_telemetry(&app, &preview);
    });
}

fn schedule_session_flow(app: AppHandle, store: Arc<Mutex<SessionStore>>, sequence: u64) {
    thread::spawn(move || {
        for (delay_ms, next_status) in [
            (900_u64, SessionStatus::Connecting),
            (1200_u64, SessionStatus::Mirroring),
        ] {
            thread::sleep(Duration::from_millis(delay_ms));

            let snapshot = {
                let mut guard = match store.lock() {
                    Ok(guard) => guard,
                    Err(_) => return,
                };

                if guard.sequence != sequence || guard.snapshot.status == SessionStatus::Idle {
                    return;
                }

                if matches!(guard.snapshot.status, SessionStatus::Mirroring | SessionStatus::Recording) {
                    return;
                }

                guard.snapshot.status = next_status;
                guard.snapshot.clone()
            };

            let _ = emit_session_status(&app, &snapshot);

            if next_status == SessionStatus::Mirroring {
                schedule_preview_stream(app.clone(), store.clone(), sequence);
            }
        }
    });
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
fn start_session(app: AppHandle, state: State<'_, AppState>) -> CommandResult<SessionSnapshot> {
    let (snapshot, sequence, should_schedule) = {
        let mut guard = state.inner.lock().map_err(|error| error.to_string())?;

        let should_schedule = guard.snapshot.status == SessionStatus::Idle;

        if should_schedule {
            guard.sequence += 1;
            guard.snapshot.status = SessionStatus::Discovering;
            reset_preview(&mut guard);
        }

        (guard.snapshot.clone(), guard.sequence, should_schedule)
    };

    emit_session_status(&app, &snapshot)?;
    if should_schedule {
        let preview = {
            let guard = state.inner.lock().map_err(|error| error.to_string())?;
            guard.preview.clone()
        };
        emit_preview_telemetry(&app, &preview)?;
    }

    if should_schedule {
        schedule_session_flow(app, state.inner.clone(), sequence);
    }

    Ok(snapshot)
}

#[tauri::command]
fn stop_session(app: AppHandle, state: State<'_, AppState>) -> CommandResult<SessionSnapshot> {
    let (snapshot, preview) = {
        let mut guard = state.inner.lock().map_err(|error| error.to_string())?;
        guard.sequence += 1;
        guard.snapshot.status = SessionStatus::Idle;
        reset_preview(&mut guard);
        (guard.snapshot.clone(), guard.preview.clone())
    };

    emit_session_status(&app, &snapshot)?;
    emit_preview_telemetry(&app, &preview)?;
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
            start_session,
            stop_session,
            take_screenshot,
            start_recording,
            stop_recording
        ])
        .plugin(tauri_plugin_opener::init())
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
