use crate::models::{
    PreviewDeliveryMode, PreviewDiagnosticsSnapshot, PreviewStreamDescriptor, PreviewTelemetry,
    ReceiverRuntimeSnapshot, ReceiverRuntimeState, ReceiverTransport, SessionSnapshot,
    SessionStatus,
};
use crate::preview_fragments::LivePreviewBuffer;
use crate::remux::RemuxBlueprint;

const IDLE_DEVICE_NAME: &str = "Waiting for iPhone";

pub(crate) struct SessionStore {
    pub(crate) sequence: u64,
    pub(crate) active_session_id: Option<String>,
    pub(crate) snapshot: SessionSnapshot,
    pub(crate) preview: PreviewTelemetry,
    pub(crate) preview_stream: PreviewStreamDescriptor,
    pub(crate) live_preview_buffer: LivePreviewBuffer,
    pub(crate) remux_blueprint: RemuxBlueprint,
    pub(crate) receiver_runtime: ReceiverRuntimeSnapshot,
    pub(crate) preview_diagnostics: PreviewDiagnosticsSnapshot,
}

impl Default for SessionStore {
    fn default() -> Self {
        let remux_blueprint = RemuxBlueprint::fixture_preview();
        let preview_stream = preview_stream_from_blueprint(&remux_blueprint, ReceiverTransport::Fixture);

        Self {
            sequence: 0,
            active_session_id: None,
            snapshot: SessionSnapshot {
                status: SessionStatus::Idle,
                capture_count: 0,
                device_name: String::from(IDLE_DEVICE_NAME),
                receiver_id: None,
                receiver_protocol_version: None,
                receiver_capabilities: Vec::new(),
            },
            preview: PreviewTelemetry {
                frame_number: 0,
                fps: 0,
                bitrate_kbps: 0,
                latency_ms: 0,
                activity: 0.0,
            },
            preview_stream,
            live_preview_buffer: LivePreviewBuffer::new(),
            remux_blueprint: remux_blueprint.clone(),
            receiver_runtime: ReceiverRuntimeSnapshot {
                state: ReceiverRuntimeState::Idle,
                transport: ReceiverTransport::Fixture,
                stream_id: remux_blueprint.stream_id.clone(),
                queued_segments: 0,
                last_error: None,
            },
            preview_diagnostics: PreviewDiagnosticsSnapshot {
                transport: ReceiverTransport::Fixture,
                init_segment_ready: true,
                track_timescale: remux_blueprint.track.timescale,
                pending_samples: 0,
                queued_segments: remux_blueprint.queued_segment_count(),
                emitted_segments: 0,
                delivered_segments: 0,
                last_access_unit_index: None,
                last_access_unit_duration: None,
                last_queued_sequence_number: None,
                last_queued_first_sample_index: None,
                last_queued_last_sample_index: None,
                last_queued_duration: None,
                last_delivered_sequence_number: None,
                last_delivered_first_sample_index: None,
                last_delivered_last_sample_index: None,
            },
        }
    }
}

pub(crate) fn preview_stream_from_blueprint(
    blueprint: &RemuxBlueprint,
    transport: ReceiverTransport,
) -> PreviewStreamDescriptor {
    PreviewStreamDescriptor {
        stream_id: blueprint.stream_id.clone(),
        transport,
        delivery_mode: match transport {
            ReceiverTransport::Fixture => PreviewDeliveryMode::StaticPaths,
            ReceiverTransport::Airplayserver => PreviewDeliveryMode::CommandStream,
        },
        mime_type: blueprint.mime_type.clone(),
        init_segment_path: blueprint.init_segment_path.clone(),
        media_segment_paths: blueprint
            .media_segments
            .iter()
            .map(|segment| segment.file_path.clone())
            .collect(),
        should_loop: blueprint.should_loop,
    }
}

pub(crate) fn sync_preview_diagnostics(store: &mut SessionStore) {
    store.preview_diagnostics.transport = store.receiver_runtime.transport;
    store.preview_diagnostics.track_timescale = store.remux_blueprint.track.timescale;
    store.preview_diagnostics.pending_samples = store.live_preview_buffer.pending_sample_count();
    store.preview_diagnostics.queued_segments = match store.receiver_runtime.transport {
        ReceiverTransport::Fixture => store.remux_blueprint.queued_segment_count(),
        ReceiverTransport::Airplayserver => store.live_preview_buffer.queued_segment_count(),
    };
    store.preview_diagnostics.init_segment_ready = match store.receiver_runtime.transport {
        ReceiverTransport::Fixture => true,
        ReceiverTransport::Airplayserver => store.live_preview_buffer.has_init_segment(),
    };
}

pub(crate) fn reset_preview_diagnostics(
    store: &mut SessionStore,
    transport: ReceiverTransport,
    init_segment_ready: bool,
) {
    store.preview_diagnostics = PreviewDiagnosticsSnapshot {
        transport,
        init_segment_ready,
        track_timescale: store.remux_blueprint.track.timescale,
        pending_samples: 0,
        queued_segments: if transport == ReceiverTransport::Fixture {
            store.remux_blueprint.queued_segment_count()
        } else {
            0
        },
        emitted_segments: 0,
        delivered_segments: 0,
        last_access_unit_index: None,
        last_access_unit_duration: None,
        last_queued_sequence_number: None,
        last_queued_first_sample_index: None,
        last_queued_last_sample_index: None,
        last_queued_duration: None,
        last_delivered_sequence_number: None,
        last_delivered_first_sample_index: None,
        last_delivered_last_sample_index: None,
    };
    sync_preview_diagnostics(store);
}

pub(crate) fn reset_preview(store: &mut SessionStore) {
    store.preview = PreviewTelemetry {
        frame_number: 0,
        fps: 0,
        bitrate_kbps: 0,
        latency_ms: 0,
        activity: 0.0,
    };
}

pub(crate) fn clear_session_identity(store: &mut SessionStore) {
    store.snapshot.device_name = String::from(IDLE_DEVICE_NAME);
    store.snapshot.receiver_id = None;
    store.snapshot.receiver_protocol_version = None;
    store.snapshot.receiver_capabilities.clear();
}

pub(crate) fn reset_fixture_transport(store: &mut SessionStore) {
    let remux_blueprint = RemuxBlueprint::fixture_preview();
    store.preview_stream = preview_stream_from_blueprint(&remux_blueprint, ReceiverTransport::Fixture);
    store.live_preview_buffer.reset();
    store.remux_blueprint = remux_blueprint.clone();
    store.receiver_runtime.transport = ReceiverTransport::Fixture;
    store.receiver_runtime.stream_id = remux_blueprint.stream_id;
    reset_preview_diagnostics(store, ReceiverTransport::Fixture, true);
}

pub(crate) fn prepare_live_transport(store: &mut SessionStore, stream_id: String) {
    store.live_preview_buffer.reset();
    store.remux_blueprint = RemuxBlueprint::live_preview(stream_id.clone());
    store.preview_stream = preview_stream_from_blueprint(&store.remux_blueprint, ReceiverTransport::Airplayserver);
    store.receiver_runtime.transport = ReceiverTransport::Airplayserver;
    store.receiver_runtime.stream_id = stream_id;
    reset_preview_diagnostics(store, ReceiverTransport::Airplayserver, false);
}

pub(crate) fn refresh_live_preview_descriptor(store: &mut SessionStore) {
    store.preview_stream = preview_stream_from_blueprint(&store.remux_blueprint, ReceiverTransport::Airplayserver);
}

pub(crate) fn set_receiver_runtime_state(store: &mut SessionStore, state: ReceiverRuntimeState) {
    store.receiver_runtime.state = state;
    store.receiver_runtime.queued_segments = match state {
        ReceiverRuntimeState::Idle => 0,
        ReceiverRuntimeState::Priming => 1,
        ReceiverRuntimeState::Ready | ReceiverRuntimeState::Streaming => match store.receiver_runtime.transport {
            ReceiverTransport::Fixture => store.remux_blueprint.queued_segment_count(),
            ReceiverTransport::Airplayserver => store.remux_blueprint.buffered_access_unit_count(),
        },
    };
    store.receiver_runtime.last_error = None;
    sync_preview_diagnostics(store);
}

pub(crate) fn preview_fps_from_duration(duration: u32, timescale: u32) -> u16 {
    if duration == 0 {
        return 0;
    }

    ((timescale as f32 / duration as f32).round() as u16).max(1)
}

pub(crate) fn preview_bitrate_kbps(size_bytes: usize, duration: u32, timescale: u32) -> u32 {
    if duration == 0 {
        return 0;
    }

    ((size_bytes as u64 * 8 * timescale as u64) / (duration as u64 * 1_000)) as u32
}

pub(crate) fn preview_activity(size_bytes: usize) -> f32 {
    ((size_bytes as f32 / 16_000.0).clamp(0.15, 1.0) * 10.0).round() / 10.0
}