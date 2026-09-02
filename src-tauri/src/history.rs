use crate::models::{CommandResult, ConnectionHistoryEntry, DiagnosticsExport};
use crate::persistence::durable_replace;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager};

const CONNECTION_HISTORY_FILE: &str = "connection-history.json";
const MAX_HISTORY_ENTRIES: usize = 250;
static CONNECTION_HISTORY_LOCK: Mutex<()> = Mutex::new(());

#[derive(Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ConnectionHistoryRegistry {
    entries: Vec<ConnectionHistoryEntry>,
}

pub(crate) fn now_unix_timestamp() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or(0)
}

fn connection_history_path(app: &AppHandle) -> CommandResult<PathBuf> {
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?;
    Ok(app_data_dir.join(CONNECTION_HISTORY_FILE))
}

fn load_registry(app: &AppHandle) -> CommandResult<ConnectionHistoryRegistry> {
    let file_path = connection_history_path(app)?;
    if !file_path.exists() {
        let backup_path = file_path.with_extension("json.bak");
        if !backup_path.exists() {
            return Ok(ConnectionHistoryRegistry::default());
        }
        let backup = fs::read_to_string(backup_path).map_err(|error| error.to_string())?;
        return serde_json::from_str::<ConnectionHistoryRegistry>(&backup)
            .map_err(|error| error.to_string());
    }

    let contents = fs::read_to_string(&file_path).map_err(|error| error.to_string())?;
    serde_json::from_str::<ConnectionHistoryRegistry>(&contents)
        .or_else(|primary_error| {
            let backup_path = file_path.with_extension("json.bak");
            let backup = fs::read_to_string(backup_path).map_err(|_| primary_error)?;
            serde_json::from_str::<ConnectionHistoryRegistry>(&backup)
        })
        .map_err(|error| error.to_string())
}

fn save_registry(app: &AppHandle, registry: &ConnectionHistoryRegistry) -> CommandResult<()> {
    let file_path = connection_history_path(app)?;
    let payload = serde_json::to_vec_pretty(registry).map_err(|error| error.to_string())?;
    let backup_path = file_path.with_extension("json.bak");
    durable_replace(&file_path, &backup_path, &payload)
}

pub(crate) fn append_history_entry(
    app: &AppHandle,
    mut entry: ConnectionHistoryEntry,
) -> CommandResult<()> {
    let _history_guard = CONNECTION_HISTORY_LOCK
        .lock()
        .map_err(|error| error.to_string())?;
    let mut registry = load_registry(app)?;
    if entry.id.trim().is_empty() {
        entry.id = format!("event-{}-{}", entry.occurred_at, registry.entries.len() + 1);
    }

    registry.entries.push(entry);
    if registry.entries.len() > MAX_HISTORY_ENTRIES {
        let overflow = registry.entries.len() - MAX_HISTORY_ENTRIES;
        registry.entries.drain(0..overflow);
    }

    save_registry(app, &registry)
}

pub(crate) fn get_connection_history(
    app: &AppHandle,
) -> CommandResult<Vec<ConnectionHistoryEntry>> {
    let _history_guard = CONNECTION_HISTORY_LOCK
        .lock()
        .map_err(|error| error.to_string())?;
    let mut entries = load_registry(app)?.entries;
    entries.sort_by(|left, right| {
        right
            .occurred_at
            .cmp(&left.occurred_at)
            .then_with(|| right.id.cmp(&left.id))
    });
    Ok(entries)
}

pub(crate) fn export_diagnostics_value(
    app: &AppHandle,
    report: &Value,
) -> CommandResult<DiagnosticsExport> {
    let exported_at = now_unix_timestamp();
    let base_dir = app
        .path()
        .document_dir()
        .or_else(|_| app.path().download_dir())
        .map_err(|error| error.to_string())?
        .join("MirrorSim")
        .join("Diagnostics");
    fs::create_dir_all(&base_dir).map_err(|error| error.to_string())?;

    let payload = serde_json::to_vec_pretty(report).map_err(|error| error.to_string())?;
    let (file_name, file_path) = (1_u16..=999)
        .find_map(|attempt| {
            let suffix = if attempt == 1 {
                String::new()
            } else {
                format!("-{attempt}")
            };
            let file_name = format!("mirrorsim_diagnostics_{exported_at}{suffix}.json");
            let file_path = base_dir.join(&file_name);
            match OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&file_path)
            {
                Ok(mut file) => match file.write_all(&payload).and_then(|_| file.sync_all()) {
                    Ok(()) => Some(Ok((file_name, file_path))),
                    Err(error) => {
                        let _ = fs::remove_file(&file_path);
                        Some(Err(error.to_string()))
                    }
                },
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => None,
                Err(error) => Some(Err(error.to_string())),
            }
        })
        .transpose()?
        .ok_or_else(|| String::from("could not allocate a unique diagnostics filename"))?;

    let entry_count = report
        .get("history")
        .and_then(|value| value.as_array())
        .map_or(0, |entries| entries.len());

    Ok(DiagnosticsExport {
        file_name,
        file_path: file_path.to_string_lossy().into_owned(),
        exported_at,
        entry_count,
    })
}
