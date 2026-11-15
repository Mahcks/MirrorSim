//! Bounded, payload-free flight recorder. Sampling and disk I/O never run on
//! the receiver's media thread; incident hooks only retain in-memory evidence.
use crate::commands::redact_diagnostics;
use crate::models::{ReceiverTransport, SessionStatus};
use crate::persistence::durable_replace;
use crate::runtime::AppState;
use crate::state::SessionStore;
use serde::Serialize;
use serde_json::{json, Value};
use std::collections::{BTreeSet, VecDeque};
use std::io::Read;
use std::path::Path;
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager};

const SAMPLE_MS: u64 = 2_000;
const MAX_SAMPLES: usize = 3_600;
const MAX_INCIDENTS: usize = 4;
const BEFORE_SAMPLES: usize = 60;
const AFTER_MS: u64 = 30_000;
const MAX_CHECKPOINT_BYTES: u64 = 32 * 1024 * 1024;
const CHECKPOINT_FILE: &str = "flight-recorder.json";

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Incident {
    elapsed_ms: u64,
    reason: String,
    trigger: Arc<Value>,
    before: Vec<Arc<Value>>,
    after: Vec<Arc<Value>>,
    receiver_logs: Vec<String>,
    receiver_logs_after: Vec<String>,
}

#[derive(Clone)]
pub(crate) struct FlightRecorder {
    started: Instant,
    started_at_ms: u64,
    timeline: VecDeque<Arc<Value>>,
    incidents: VecDeque<Incident>,
    previous_run: Option<Arc<Value>>,
    persistence_error: Option<String>,
    active_conditions: BTreeSet<&'static str>,
    last_context: Option<(u64, u64)>,
    last_decoded: Option<u64>,
    decoded_changed_at: u64,
    pub(crate) last_video_at: Option<Instant>,
    pub(crate) last_audio_at: Option<Instant>,
    pub(crate) last_client_report_at: Option<Instant>,
    pub(crate) video_received: u64,
    pub(crate) audio_received: u64,
    revision: u64,
}

impl Default for FlightRecorder {
    fn default() -> Self {
        Self {
            started: Instant::now(),
            started_at_ms: SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis() as u64,
            timeline: VecDeque::new(),
            incidents: VecDeque::new(),
            previous_run: None,
            persistence_error: None,
            active_conditions: BTreeSet::new(),
            last_context: None,
            last_decoded: None,
            decoded_changed_at: 0,
            last_video_at: None,
            last_audio_at: None,
            last_client_report_at: None,
            video_received: 0,
            audio_received: 0,
            revision: 0,
        }
    }
}

impl FlightRecorder {
    fn elapsed_ms(&self) -> u64 {
        self.started.elapsed().as_millis() as u64
    }

    pub(crate) fn report(&self) -> Value {
        json!({
            "schemaVersion": 1, "sampleIntervalMs": SAMPLE_MS,
            "maxSamples": MAX_SAMPLES, "maxIncidents": MAX_INCIDENTS,
            "persistenceError": self.persistence_error,
            "currentRun": {
                "startedAtMs": self.started_at_ms,
                "appVersion": env!("CARGO_PKG_VERSION"),
                "runtimeManifest": serde_json::from_str::<Value>(include_str!("../../receivers/runtime-manifest.json")).ok(),
                "timeline": self.timeline, "incidents": self.incidents,
            },
            "previousRun": self.previous_run,
        })
    }

    fn retain_incident(&mut self, reason: &str, sample: Value, logs: Vec<String>) {
        let elapsed_ms = sample["elapsedMs"].as_u64().unwrap_or(0);
        let reason: String = reason.chars().take(512).collect();
        // Repeated native errors must not evict the lead-up every frame.
        if self.incidents.iter().any(|incident| {
            incident.reason == reason && elapsed_ms.saturating_sub(incident.elapsed_ms) < 60_000
        }) {
            return;
        }
        let before = self
            .timeline
            .iter()
            .rev()
            .take(BEFORE_SAMPLES)
            .cloned()
            .collect::<Vec<_>>()
            .into_iter()
            .rev()
            .collect();
        self.incidents.push_back(Incident {
            elapsed_ms,
            reason,
            trigger: Arc::new(sample),
            before,
            after: Vec::new(),
            receiver_logs: logs,
            receiver_logs_after: Vec::new(),
        });
        while self.incidents.len() > MAX_INCIDENTS {
            self.incidents.pop_front();
        }
        self.revision = self.revision.wrapping_add(1);
    }

    fn observe(&mut self, sample: Value, logs: Vec<String>) {
        let now = sample["elapsedMs"].as_u64().unwrap_or(0);
        let context = (
            sample["connectionGeneration"].as_u64().unwrap_or(0),
            sample["configGeneration"].as_u64().unwrap_or(0),
        );
        let decoded = sample["client"]["decodedOutputCount"].as_u64();
        if self.last_context != Some(context) || self.last_decoded != decoded {
            self.decoded_changed_at = now;
            self.last_decoded = decoded;
        }
        if self.last_context != Some(context) {
            self.active_conditions.clear();
        }
        self.last_context = Some(context);

        let live = matches!(sample["status"].as_str(), Some("mirroring" | "recording"));
        let visible = sample["client"]["documentVisible"].as_bool() == Some(true);
        let unpaused = sample["senderPaused"].as_bool() == Some(false);
        let fresh = sample["clientMatchesStream"].as_bool() == Some(true)
            && sample["clientReportAgeMs"]
                .as_u64()
                .is_some_and(|age| age < 6_000);
        let mut conditions = BTreeSet::new();
        if live && unpaused && visible {
            if sample["lastVideoAgeMs"]
                .as_u64()
                .is_some_and(|age| age >= 15_000)
            {
                conditions.insert("video-input-gap");
            }
            if sample["clientReportAgeMs"]
                .as_u64()
                .is_some_and(|age| age >= 10_000)
            {
                conditions.insert("client-diagnostics-gap");
            }
            if fresh {
                if decoded.is_some_and(|count| count > 0)
                    && now.saturating_sub(self.decoded_changed_at) >= 6_000
                    && sample["lastVideoAgeMs"]
                        .as_u64()
                        .is_some_and(|age| age < 3_000)
                {
                    conditions.insert("video-received-without-decoder-progress");
                }
                if sample["client"]["surfaceStatus"].as_str() == Some("error") {
                    conditions.insert("preview-error");
                }
                if sample["client"]["playbackBackend"].as_str() == Some("mse")
                    && sample["client"]["bufferLeadMs"]
                        .as_f64()
                        .is_some_and(|lead| lead > 2_000.0)
                {
                    conditions.insert("preview-buffer-over-two-seconds");
                }
            }
        } else {
            // A deliberate pause/hidden window is not a decoder stall.
            self.decoded_changed_at = now;
        }
        for reason in conditions
            .difference(&self.active_conditions)
            .copied()
            .collect::<Vec<_>>()
        {
            self.retain_incident(reason, sample.clone(), logs.clone());
        }
        self.active_conditions = conditions;
        let sample = Arc::new(sample);
        for incident in &mut self.incidents {
            if now > incident.elapsed_ms
                && now <= incident.elapsed_ms + AFTER_MS
                && incident.after.len() < (AFTER_MS / SAMPLE_MS) as usize
            {
                incident.after.push(sample.clone());
                incident.receiver_logs_after = logs.clone();
                if now >= incident.elapsed_ms + AFTER_MS - SAMPLE_MS {
                    self.revision = self.revision.wrapping_add(1);
                }
            }
        }
        self.timeline.push_back(sample);
        while self.timeline.len() > MAX_SAMPLES {
            self.timeline.pop_front();
        }
    }
}

fn age_ms(at: Option<Instant>) -> Option<u64> {
    at.map(|at| at.elapsed().as_millis() as u64)
}

fn sample(store: &SessionStore) -> Value {
    let recorder = &store.flight_recorder;
    let client = store
        .preview_client_diagnostics
        .as_ref()
        .and_then(|value| value.get("snapshot"));
    // Retain only diagnostic fields, never media payloads or arbitrary client objects.
    let mut retained = serde_json::Map::new();
    for key in [
        "playbackBackend",
        "decodedOutputCount",
        "presentedFrameCount",
        "decoderQueueSize",
        "decoderClientRecoveryCount",
        "mediaAppendCount",
        "appendErrorCount",
        "emptyPollCount",
        "lastAppendedSequenceNumber",
        "lastKeyframeSequenceNumber",
        "segmentsSinceKeyframe",
        "lastDecodedFrameAgeMs",
        "lastAppendAgeMs",
        "lastAudioReceivedAgeMs",
        "surfaceStatus",
        "surfaceError",
        "lastMediaError",
        "documentVisible",
        "bufferLeadMs",
        "playbackRate",
        "droppedVideoFrames",
        "currentTime",
        "renderSurfaceHealthy",
        "canvasContextLossCount",
    ] {
        if let Some(value) = client.and_then(|client| client.get(key)) {
            let value = match value {
                Value::String(text) => Value::String(text.chars().take(512).collect()),
                Value::Null | Value::Bool(_) | Value::Number(_) => value.clone(),
                _ => continue,
            };
            retained.insert(key.into(), value);
        }
    }
    json!({
        "elapsedMs": recorder.elapsed_ms(), "status": store.snapshot.status,
        "connectionGeneration": store.connection_attempt_generation,
        "configGeneration": store.preview_config_generation,
        "redactionContext": {
            "sessionId": store.active_session_id,
            "deviceId": store.snapshot.current_device_id,
            "deviceKey": store.snapshot.current_device_key,
        },
        "receiverState": store.receiver_runtime.state,
        "senderPaused": store.receiver_runtime.video_sender_paused,
        "lastVideoAgeMs": age_ms(recorder.last_video_at),
        "lastAudioAgeMs": age_ms(recorder.last_audio_at),
        "videoReceived": recorder.video_received, "audioReceived": recorder.audio_received,
        "queuedAudioFrames": store.preview_audio_frames.len(),
        "preview": store.preview_diagnostics,
        "clientReportAgeMs": age_ms(recorder.last_client_report_at),
        "clientMatchesStream": client.is_some_and(|client|
            client["streamId"].as_str() == Some(store.preview_stream.stream_id.as_str())
            && client["configGeneration"].as_u64() == Some(store.preview_stream.config_generation)),
        "client": retained,
    })
}

fn recent_logs(store: &SessionStore) -> Vec<String> {
    store
        .sidecar_logs
        .iter()
        .rev()
        .take(80)
        .cloned()
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect()
}

pub(crate) fn mark_incident(store: &mut SessionStore, reason: &str) {
    let snapshot = sample(store);
    let logs = recent_logs(store);
    store
        .flight_recorder
        .retain_incident(reason, snapshot, logs);
}

fn load_checkpoint(path: &Path) -> Result<Option<Value>, String> {
    let file = match std::fs::File::open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.to_string()),
    };
    let mut bytes = Vec::new();
    file.take(MAX_CHECKPOINT_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| e.to_string())?;
    if bytes.len() as u64 > MAX_CHECKPOINT_BYTES {
        return Err("flight recorder checkpoint too large".into());
    }
    let value: Value = serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
    if value["schemaVersion"] != 1 {
        return Err("unsupported flight recorder checkpoint".into());
    }
    match value.get("currentRun").filter(|run| run.is_object()) {
        Some(run) => Ok(Some(run.clone())),
        None => Err("flight recorder checkpoint has no current run".into()),
    }
}

fn restore_checkpoint(path: &Path, backup: &Path) -> Result<Option<Value>, String> {
    match load_checkpoint(path) {
        Ok(Some(value)) => Ok(Some(value)),
        primary => match load_checkpoint(backup) {
            Ok(Some(value)) => Ok(Some(value)),
            Ok(None) => primary,
            Err(error) => Err(error),
        },
    }
}

#[cfg(windows)]
fn process_metrics(pid: u32) -> Value {
    use windows_sys::Win32::Foundation::{CloseHandle, FILETIME};
    use windows_sys::Win32::System::ProcessStatus::{
        GetProcessMemoryInfo, PROCESS_MEMORY_COUNTERS_EX,
    };
    use windows_sys::Win32::System::Threading::{
        GetProcessHandleCount, GetProcessTimes, OpenProcess, PROCESS_QUERY_INFORMATION,
        PROCESS_VM_READ,
    };
    // A short-lived read-only handle. Unavailable/exited processes yield null,
    // never a fabricated zero or a receiver recovery action.
    unsafe {
        let handle = OpenProcess(PROCESS_QUERY_INFORMATION | PROCESS_VM_READ, 0, pid);
        if handle.is_null() {
            return json!({"pid": pid, "available": false});
        }
        let mut memory: PROCESS_MEMORY_COUNTERS_EX = std::mem::zeroed();
        let size = std::mem::size_of::<PROCESS_MEMORY_COUNTERS_EX>() as u32;
        memory.cb = size;
        let memory_ok = GetProcessMemoryInfo(
            handle,
            (&mut memory as *mut PROCESS_MEMORY_COUNTERS_EX).cast(),
            size,
        ) != 0;
        let mut handles = 0;
        let handles_ok = GetProcessHandleCount(handle, &mut handles) != 0;
        let mut creation: FILETIME = std::mem::zeroed();
        let mut exit: FILETIME = std::mem::zeroed();
        let mut kernel: FILETIME = std::mem::zeroed();
        let mut user: FILETIME = std::mem::zeroed();
        let times_ok =
            GetProcessTimes(handle, &mut creation, &mut exit, &mut kernel, &mut user) != 0;
        CloseHandle(handle);
        let ticks =
            |time: FILETIME| ((time.dwHighDateTime as u64) << 32) | time.dwLowDateTime as u64;
        json!({"pid": pid, "available": true,
            "privateBytes": memory_ok.then_some(memory.PrivateUsage),
            "workingSetBytes": memory_ok.then_some(memory.WorkingSetSize),
            "handleCount": handles_ok.then_some(handles),
            "cpuTimeMs": times_ok.then_some((ticks(kernel) + ticks(user)) / 10_000)})
    }
}

#[cfg(not(windows))]
fn process_metrics(_pid: u32) -> Value {
    Value::Null
}

pub(crate) fn start(app: &AppHandle) {
    let store = app.state::<AppState>().inner.clone();
    let sidecar = app.state::<AppState>().sidecar.clone();
    let path = app
        .path()
        .app_data_dir()
        .map(|dir| dir.join(CHECKPOINT_FILE));
    std::thread::spawn(move || {
        let path = match path {
            Ok(path) => path,
            Err(error) => {
                if let Ok(mut store) = store.lock() {
                    store.flight_recorder.persistence_error = Some(error.to_string());
                }
                return;
            }
        };
        let backup = path.with_extension("json.bak");
        let previous = restore_checkpoint(&path, &backup);
        if let Ok(mut store) = store.lock() {
            match previous {
                Ok(value) => store.flight_recorder.previous_run = value.map(Arc::new),
                Err(error) => store.flight_recorder.persistence_error = Some(error),
            }
        }
        let mut last_save = Instant::now();
        let mut saved_revision = 0;
        loop {
            std::thread::sleep(Duration::from_millis(SAMPLE_MS));
            let receiver_pid = sidecar
                .try_lock()
                .ok()
                .and_then(|runtime| runtime.as_ref().map(|runtime| runtime.process_id()));
            let resources = json!({"app": process_metrics(std::process::id()),
                "receiver": receiver_pid.map(process_metrics)});
            let checkpoint = {
                let Ok(mut store) = store.lock() else {
                    return;
                };
                let active = store.receiver_runtime.transport == ReceiverTransport::Airplayserver
                    && store.snapshot.status != SessionStatus::Idle;
                if !active
                    && store.flight_recorder.timeline.is_empty()
                    && store.flight_recorder.incidents.is_empty()
                {
                    continue;
                }
                let mut snapshot = sample(&store);
                snapshot["processes"] = resources;
                let logs = recent_logs(&store);
                store.flight_recorder.observe(snapshot, logs);
                let recorder = &store.flight_recorder;
                if recorder.revision != saved_revision
                    || last_save.elapsed() >= Duration::from_secs(30)
                {
                    Some((recorder.revision, recorder.clone()))
                } else {
                    None
                }
            };
            if let Some((revision, recorder)) = checkpoint {
                let mut report = recorder.report();
                // Disk work and redaction occur after releasing the media state lock.
                redact_diagnostics(&mut report);
                let result = serde_json::to_vec(&report)
                    .map_err(|e| e.to_string())
                    .and_then(|bytes| {
                        if bytes.len() as u64 > MAX_CHECKPOINT_BYTES {
                            return Err("flight recorder checkpoint too large".into());
                        }
                        durable_replace(&path, &backup, &bytes)
                    });
                if let Ok(mut store) = store.lock() {
                    store.flight_recorder.persistence_error = result.as_ref().err().cloned();
                }
                // Retry failed writes at the next normal checkpoint, not every frame.
                saved_revision = revision;
                last_save = Instant::now();
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn live(at: u64, decoded: u64) -> Value {
        json!({"elapsedMs": at, "connectionGeneration": 1, "configGeneration": 1,
            "status": "mirroring", "senderPaused": false, "lastVideoAgeMs": 0,
            "clientReportAgeMs": 0, "clientMatchesStream": true,
            "client": {"documentVisible": true, "decodedOutputCount": decoded}})
    }

    #[test]
    fn soak_history_is_bounded_and_incident_survives_timeline_eviction() {
        let mut recorder = FlightRecorder::default();
        for i in 0..10 {
            recorder.observe(live(i * SAMPLE_MS, i), vec![]);
        }
        recorder.retain_incident(
            "sender-disconnected",
            live(20_000, 9),
            vec!["socket closed".into()],
        );
        for i in 10..10_000 {
            recorder.observe(live(i * SAMPLE_MS, i), vec![]);
        }
        assert_eq!(recorder.timeline.len(), MAX_SAMPLES);
        assert_eq!(recorder.incidents.len(), 1);
        assert_eq!(recorder.incidents[0].before.len(), 10);
        assert_eq!(recorder.incidents[0].after.len(), 15);
        assert_eq!(recorder.incidents[0].receiver_logs[0], "socket closed");
    }

    #[test]
    fn stalled_decoder_triggers_once_and_reset_pause_hidden_or_stale_reports_do_not() {
        let mut recorder = FlightRecorder::default();
        for i in 0..10 {
            recorder.observe(live(i * SAMPLE_MS, 12), vec![]);
        }
        assert_eq!(recorder.incidents.len(), 1);
        assert_eq!(
            recorder.incidents[0].reason,
            "video-received-without-decoder-progress"
        );
        for field in ["pause", "hidden", "stale", "reset"] {
            let mut recorder = FlightRecorder::default();
            for i in 0..10 {
                let mut value = live(i * SAMPLE_MS, 12);
                match field {
                    "pause" => value["senderPaused"] = json!(true),
                    "hidden" => value["client"]["documentVisible"] = json!(false),
                    "stale" => value["clientMatchesStream"] = json!(false),
                    _ => value["configGeneration"] = json!(i),
                }
                recorder.observe(value, vec![]);
            }
            assert!(recorder.incidents.is_empty(), "{field}");
        }
    }

    #[test]
    fn repeated_errors_are_coalesced_and_incidents_are_bounded() {
        let mut recorder = FlightRecorder::default();
        for _ in 0..100 {
            recorder.retain_incident("error", live(100, 1), vec![]);
        }
        assert_eq!(recorder.incidents.len(), 1);
        for i in 1..20 {
            recorder.retain_incident("error", live(i * 60_000, i), vec![]);
        }
        assert_eq!(recorder.incidents.len(), MAX_INCIDENTS);
    }

    #[test]
    fn incident_retains_pre_reset_state_and_redacts_logs_without_retaining_media() {
        let mut store = SessionStore {
            active_session_id: Some("session-secret-value".into()),
            ..SessionStore::default()
        };
        store.snapshot.current_device_id = Some("device-secret-value".into());
        store.flight_recorder.video_received = 456;
        store.preview_client_diagnostics = Some(json!({"snapshot": {
            "decodedOutputCount": 123, "payload_base64": "DO_NOT_RETAIN_MEDIA",
            "surfaceError": "failed session-secret-value"
        }}));
        store
            .sidecar_logs
            .push_back("closed device-secret-value session-secret-value".into());
        mark_incident(&mut store, "transport interrupted");
        crate::state::reset_fixture_transport(&mut store);
        store.active_session_id = None;
        store.snapshot.current_device_id = None;
        let mut report = store.flight_recorder.report();
        redact_diagnostics(&mut report);
        let text = serde_json::to_string(&report).unwrap();
        assert!(!text.contains("session-secret-value"));
        assert!(!text.contains("device-secret-value"));
        assert!(!text.contains("DO_NOT_RETAIN_MEDIA"));
        assert_eq!(
            report["currentRun"]["incidents"][0]["trigger"]["videoReceived"],
            456
        );
        assert_eq!(
            report["currentRun"]["incidents"][0]["trigger"]["client"]["decodedOutputCount"],
            123
        );
    }

    #[test]
    fn restart_loads_one_run_and_recovers_a_corrupt_or_missing_primary() {
        let directory = std::env::temp_dir().join(format!(
            "mirrorsim-diagnostics-test-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir(&directory).unwrap();
        let path = directory.join(CHECKPOINT_FILE);
        let backup = path.with_extension("json.bak");
        let mut recorder = FlightRecorder::default();
        recorder.observe(live(0, 10), vec![]);
        recorder.previous_run = Some(Arc::new(json!({"timeline": ["older run"]})));
        let report = recorder.report();
        let bytes = serde_json::to_vec(&report).unwrap();
        durable_replace(&path, &backup, &bytes).unwrap();
        assert_eq!(
            restore_checkpoint(&path, &backup).unwrap().unwrap(),
            report["currentRun"]
        );
        durable_replace(&path, &backup, &bytes).unwrap();
        std::fs::write(&path, b"{partial write").unwrap();
        assert_eq!(
            restore_checkpoint(&path, &backup).unwrap().unwrap(),
            report["currentRun"]
        );
        std::fs::remove_file(&path).unwrap();
        assert!(restore_checkpoint(&path, &backup).unwrap().is_some());
        std::fs::remove_file(&backup).unwrap();
        std::fs::write(&path, b"{corrupt").unwrap();
        assert!(restore_checkpoint(&path, &backup).is_err());
        std::fs::remove_file(&path).unwrap();
        std::fs::remove_dir(&directory).unwrap();
    }

    #[test]
    fn input_silence_and_missing_client_reports_are_observations_not_recovery_actions() {
        let mut recorder = FlightRecorder::default();
        let mut value = live(20_000, 10);
        value["lastVideoAgeMs"] = json!(16_000);
        value["clientReportAgeMs"] = json!(12_000);
        recorder.observe(value, vec![]);
        let reasons = recorder
            .incidents
            .iter()
            .map(|i| i.reason.as_str())
            .collect::<Vec<_>>();
        assert!(reasons.contains(&"video-input-gap"));
        assert!(reasons.contains(&"client-diagnostics-gap"));
        assert_eq!(recorder.timeline[0]["status"], "mirroring");
    }

    #[cfg(windows)]
    #[test]
    fn windows_resource_probe_reads_current_process() {
        let metrics = process_metrics(std::process::id());
        assert_eq!(metrics["available"], true);
        assert!(metrics["privateBytes"].as_u64().unwrap() > 0);
        assert!(metrics["handleCount"].as_u64().unwrap() > 0);
        assert!(metrics["cpuTimeMs"].is_u64());
    }
}
