use crate::remux::RemuxBlueprint;
use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub(crate) enum SessionStatus {
    Idle,
    Discovering,
    Connecting,
    Mirroring,
    Recording,
}

#[derive(Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub(crate) enum ReceiverTransport {
    Fixture,
    Airplayserver,
}

#[derive(Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub(crate) enum ReceiverRuntimeState {
    Idle,
    Priming,
    Ready,
    Streaming,
}

#[derive(Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum PairingPhase {
    #[default]
    Idle,
    PinRequired,
    AwaitingTrust,
    Verifying,
    Paired,
    Failed,
}

#[derive(Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum PairingEntryMode {
    #[default]
    None,
    EnterOnDevice,
    EnterInApp,
    ConfirmOnly,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SessionSnapshot {
    pub(crate) status: SessionStatus,
    pub(crate) capture_count: u32,
    pub(crate) device_name: String,
    pub(crate) current_device_id: Option<String>,
    pub(crate) current_device_model: Option<String>,
    pub(crate) current_device_os_name: Option<String>,
    pub(crate) current_device_os_version: Option<String>,
    pub(crate) current_device_os_build_version: Option<String>,
    pub(crate) current_device_source_version: Option<String>,
    pub(crate) current_device_key: Option<String>,
    pub(crate) current_device_nickname: Option<String>,
    pub(crate) current_device_known: bool,
    pub(crate) current_device_trusted: bool,
    pub(crate) current_device_blocked: bool,
    pub(crate) current_device_blocked_reason: Option<String>,
    pub(crate) receiver_id: Option<String>,
    pub(crate) receiver_protocol_version: Option<String>,
    pub(crate) receiver_capabilities: Vec<String>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TrustedDevice {
    pub(crate) key: String,
    #[serde(default)]
    pub(crate) device_id: Option<String>,
    pub(crate) display_name: String,
    #[serde(default)]
    pub(crate) model: Option<String>,
    #[serde(default)]
    pub(crate) os_name: Option<String>,
    #[serde(default)]
    pub(crate) os_version: Option<String>,
    #[serde(default)]
    pub(crate) os_build_version: Option<String>,
    #[serde(default)]
    pub(crate) source_version: Option<String>,
    #[serde(default)]
    pub(crate) nickname: Option<String>,
    pub(crate) first_seen_at: u64,
    pub(crate) last_seen_at: u64,
    #[serde(default)]
    pub(crate) trusted_at: Option<u64>,
    #[serde(default)]
    pub(crate) last_successful_connection_at: Option<u64>,
    #[serde(default)]
    pub(crate) last_pairing_at: Option<u64>,
    #[serde(default)]
    pub(crate) pending_pairing: bool,
    #[serde(default)]
    pub(crate) is_blocked: bool,
    #[serde(default)]
    pub(crate) blocked_reason: Option<String>,
    #[serde(default)]
    pub(crate) last_failure_at: Option<u64>,
    #[serde(default)]
    pub(crate) last_failure_reason: Option<String>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ConnectionHistoryEntry {
    pub(crate) id: String,
    pub(crate) occurred_at: u64,
    pub(crate) event: String,
    pub(crate) status: String,
    pub(crate) message: String,
    #[serde(default)]
    pub(crate) device_name: Option<String>,
    #[serde(default)]
    pub(crate) device_id: Option<String>,
    #[serde(default)]
    pub(crate) device_model: Option<String>,
    #[serde(default)]
    pub(crate) device_os_name: Option<String>,
    #[serde(default)]
    pub(crate) device_os_version: Option<String>,
    #[serde(default)]
    pub(crate) device_key: Option<String>,
    #[serde(default)]
    pub(crate) receiver_name: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DiagnosticsExport {
    pub(crate) file_name: String,
    pub(crate) file_path: String,
    pub(crate) exported_at: u64,
    pub(crate) entry_count: usize,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AppUpdateInfo {
    pub(crate) version: String,
    pub(crate) current_version: String,
    #[serde(default)]
    pub(crate) notes: Option<String>,
    #[serde(default)]
    pub(crate) pub_date: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PairingSnapshot {
    pub(crate) phase: PairingPhase,
    pub(crate) entry_mode: PairingEntryMode,
    pub(crate) session_id: Option<String>,
    pub(crate) challenge_id: Option<String>,
    pub(crate) device_name: Option<String>,
    pub(crate) device_id: Option<String>,
    pub(crate) display_pin: Option<String>,
    pub(crate) prompt: Option<String>,
    pub(crate) failure_message: Option<String>,
    pub(crate) can_trust: bool,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PreviewTelemetry {
    pub(crate) frame_number: u64,
    pub(crate) fps: u16,
    pub(crate) bitrate_kbps: u32,
    pub(crate) latency_ms: u16,
    pub(crate) activity: f32,
}

#[derive(Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum PreviewDeliveryMode {
    StaticPaths,
    CommandStream,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PreviewStreamDescriptor {
    pub(crate) stream_id: String,
    pub(crate) config_generation: u64,
    pub(crate) transport: ReceiverTransport,
    pub(crate) delivery_mode: PreviewDeliveryMode,
    pub(crate) mime_type: String,
    pub(crate) codec: String,
    pub(crate) coded_width: u16,
    pub(crate) coded_height: u16,
    pub(crate) decoder_config_hex: String,
    pub(crate) init_segment_path: String,
    pub(crate) media_segment_paths: Vec<String>,
    pub(crate) should_loop: bool,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ReceiverRuntimeSnapshot {
    pub(crate) state: ReceiverRuntimeState,
    pub(crate) transport: ReceiverTransport,
    pub(crate) stream_id: String,
    pub(crate) queued_segments: usize,
    pub(crate) sender_volume_db: Option<f32>,
    pub(crate) last_error: Option<String>,
}

#[derive(Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum BonjourStatusKind {
    Ready,
    Missing,
    Stopped,
    Unknown,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BonjourStatusSnapshot {
    pub(crate) status: BonjourStatusKind,
    pub(crate) service_name: String,
    pub(crate) detail: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PreviewDiagnosticsSnapshot {
    pub(crate) transport: ReceiverTransport,
    pub(crate) init_segment_ready: bool,
    pub(crate) track_timescale: u32,
    pub(crate) pending_samples: usize,
    pub(crate) queued_segments: usize,
    pub(crate) emitted_segments: u32,
    pub(crate) delivered_segments: u32,
    pub(crate) last_access_unit_index: Option<u32>,
    pub(crate) last_access_unit_duration: Option<u32>,
    pub(crate) last_queued_sequence_number: Option<u32>,
    pub(crate) last_queued_first_sample_index: Option<u32>,
    pub(crate) last_queued_last_sample_index: Option<u32>,
    pub(crate) last_queued_duration: Option<u32>,
    pub(crate) last_delivered_sequence_number: Option<u32>,
    pub(crate) last_delivered_first_sample_index: Option<u32>,
    pub(crate) last_delivered_last_sample_index: Option<u32>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PreviewAudioFramePayload {
    pub(crate) stream_id: String,
    pub(crate) pts: u64,
    pub(crate) sample_rate: u32,
    pub(crate) channels: u16,
    pub(crate) bits_per_sample: u16,
    pub(crate) payload_base64: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RemuxBlueprintSnapshot {
    pub(crate) transport: ReceiverTransport,
    pub(crate) blueprint: RemuxBlueprint,
}

#[derive(Deserialize)]
#[serde(tag = "name", rename_all = "snake_case")]
pub(crate) enum SidecarEvent {
    ReceiverReady {
        receiver_id: String,
        protocol_version: String,
        capabilities: Vec<String>,
    },
    SessionStarted {
        session_id: String,
        stream_id: String,
        device_name: String,
        #[serde(default)]
        device_id: Option<String>,
        #[serde(default)]
        device_model: Option<String>,
        #[serde(default)]
        device_os_name: Option<String>,
        #[serde(default)]
        device_os_version: Option<String>,
        #[serde(default)]
        device_os_build_version: Option<String>,
        #[serde(default)]
        device_source_version: Option<String>,
    },
    PairingStateChanged {
        phase: PairingPhase,
        #[serde(default)]
        entry_mode: PairingEntryMode,
        session_id: String,
        challenge_id: String,
        #[serde(default)]
        device_name: Option<String>,
        #[serde(default)]
        device_id: Option<String>,
        #[serde(default)]
        display_pin: Option<String>,
        #[serde(default)]
        prompt: Option<String>,
        #[serde(default)]
        failure_message: Option<String>,
        #[serde(default)]
        can_trust: bool,
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
    AudioFrame {
        stream_id: String,
        pts: u64,
        sample_rate: u32,
        channels: u16,
        bits_per_sample: u16,
        #[serde(rename = "payloadBase64")]
        payload_base64: String,
    },
    AudioVolumeChanged {
        stream_id: String,
        volume_db: f32,
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

pub(crate) type CommandResult<T> = Result<T, String>;

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum ScreenshotSaveLocation {
    Pictures,
    Documents,
    Downloads,
    Custom,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SaveScreenshotRequest {
    pub(crate) file_name: String,
    pub(crate) png_base64: String,
    pub(crate) location: ScreenshotSaveLocation,
    pub(crate) custom_directory: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BeginRecordingRequest {
    pub(crate) file_name: String,
    pub(crate) location: ScreenshotSaveLocation,
    pub(crate) custom_directory: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RecordingWriteSession {
    pub(crate) recording_id: u64,
    pub(crate) file_name: String,
    pub(crate) file_path: String,
}

#[cfg(test)]
mod tests {
    use super::SidecarEvent;

    #[test]
    fn parses_sender_volume_event_from_the_jsonl_contract() {
        let event: SidecarEvent = serde_json::from_str(
            r#"{"name":"audio_volume_changed","stream_id":"stream-1","volume_db":-12.5}"#,
        )
        .expect("sender volume event should parse");

        match event {
            SidecarEvent::AudioVolumeChanged {
                stream_id,
                volume_db,
            } => {
                assert_eq!(stream_id, "stream-1");
                assert_eq!(volume_db, -12.5);
            }
            _ => panic!("unexpected sidecar event"),
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SavedScreenshot {
    pub(crate) file_name: String,
    pub(crate) file_path: String,
}
