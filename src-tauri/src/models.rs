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

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SessionSnapshot {
    pub(crate) status: SessionStatus,
    pub(crate) capture_count: u32,
    pub(crate) device_name: String,
    pub(crate) receiver_id: Option<String>,
    pub(crate) receiver_protocol_version: Option<String>,
    pub(crate) receiver_capabilities: Vec<String>,
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
    pub(crate) transport: ReceiverTransport,
    pub(crate) delivery_mode: PreviewDeliveryMode,
    pub(crate) mime_type: String,
    pub(crate) init_segment_path: String,
    pub(crate) media_segment_paths: Vec<String>,
    pub(crate) should_loop: bool,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PreviewMediaSegmentPayload {
    pub(crate) sequence_number: u32,
    pub(crate) first_sample_index: u32,
    pub(crate) last_sample_index: u32,
    pub(crate) bytes: Vec<u8>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ReceiverRuntimeSnapshot {
    pub(crate) state: ReceiverRuntimeState,
    pub(crate) transport: ReceiverTransport,
    pub(crate) stream_id: String,
    pub(crate) queued_segments: usize,
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
pub(crate) struct SaveRecordingRequest {
    pub(crate) file_name: String,
    pub(crate) media_base64: String,
    pub(crate) location: ScreenshotSaveLocation,
    pub(crate) custom_directory: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SavedScreenshot {
    pub(crate) file_name: String,
    pub(crate) file_path: String,
}