use crate::models::{
    PairingEntryMode, PairingPhase, PairingSnapshot, PreviewDeliveryMode,
    PreviewDiagnosticsSnapshot, PreviewStreamDescriptor, PreviewTelemetry, ReceiverRuntimeSnapshot,
    ReceiverRuntimeState, ReceiverTransport, SessionSnapshot, SessionStatus,
};
use crate::preview_fragments::LivePreviewBuffer;
use crate::remux::RemuxBlueprint;

const IDLE_DEVICE_NAME: &str = "Waiting for iPhone";

pub(crate) struct SessionStore {
    pub(crate) sequence: u64,
    pub(crate) active_session_id: Option<String>,
    pub(crate) require_local_session_approval: bool,
    pub(crate) require_known_device: bool,
    pub(crate) pending_local_session_approval: bool,
    pub(crate) native_pairing_approved_for_session: bool,
    pub(crate) remember_pairing_approval: bool,
    pub(crate) snapshot: SessionSnapshot,
    pub(crate) pairing: PairingSnapshot,
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
        let preview_stream =
            preview_stream_from_blueprint(&remux_blueprint, ReceiverTransport::Fixture);

        Self {
            sequence: 0,
            active_session_id: None,
            require_local_session_approval: false,
            require_known_device: false,
            pending_local_session_approval: false,
            native_pairing_approved_for_session: false,
            remember_pairing_approval: false,
            snapshot: SessionSnapshot {
                status: SessionStatus::Idle,
                capture_count: 0,
                device_name: String::from(IDLE_DEVICE_NAME),
                current_device_id: None,
                current_device_model: None,
                current_device_os_name: None,
                current_device_os_version: None,
                current_device_os_build_version: None,
                current_device_source_version: None,
                current_device_key: None,
                current_device_nickname: None,
                current_device_known: false,
                current_device_trusted: false,
                current_device_blocked: false,
                current_device_blocked_reason: None,
                receiver_id: None,
                receiver_protocol_version: None,
                receiver_capabilities: Vec::new(),
            },
            pairing: PairingSnapshot {
                phase: PairingPhase::Idle,
                entry_mode: PairingEntryMode::None,
                device_name: None,
                device_id: None,
                display_pin: None,
                prompt: None,
                failure_message: None,
                can_trust: false,
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

pub(crate) fn clear_current_device_identity(store: &mut SessionStore) {
    store.snapshot.device_name = String::from(IDLE_DEVICE_NAME);
    store.snapshot.current_device_id = None;
    store.snapshot.current_device_model = None;
    store.snapshot.current_device_os_name = None;
    store.snapshot.current_device_os_version = None;
    store.snapshot.current_device_os_build_version = None;
    store.snapshot.current_device_source_version = None;
    store.snapshot.current_device_key = None;
    store.snapshot.current_device_nickname = None;
    store.snapshot.current_device_known = false;
    store.snapshot.current_device_trusted = false;
    store.snapshot.current_device_blocked = false;
    store.snapshot.current_device_blocked_reason = None;
}

pub(crate) fn clear_session_identity(store: &mut SessionStore) {
    clear_current_device_identity(store);
    store.snapshot.receiver_id = None;
    store.snapshot.receiver_protocol_version = None;
    store.snapshot.receiver_capabilities.clear();
}

pub(crate) fn clear_pairing(store: &mut SessionStore) {
    store.pending_local_session_approval = false;
    store.remember_pairing_approval = false;
    store.pairing = PairingSnapshot {
        phase: PairingPhase::Idle,
        entry_mode: PairingEntryMode::None,
        device_name: None,
        device_id: None,
        display_pin: None,
        prompt: None,
        failure_message: None,
        can_trust: false,
    };
}

pub(crate) fn resume_listening_after_disconnect(store: &mut SessionStore, stream_id: String) {
    store.snapshot.status = SessionStatus::Discovering;
    clear_current_device_identity(store);
    clear_pairing(store);
    store.native_pairing_approved_for_session = false;
    reset_preview(store);
    prepare_live_transport(store, stream_id);
    set_receiver_runtime_state(store, ReceiverRuntimeState::Ready);
}

pub(crate) fn resume_local_session_approval(store: &mut SessionStore) {
    store.pending_local_session_approval = false;
    store.require_local_session_approval = false;

    if store.live_preview_buffer.queued_segment_count() > 0 {
        if store.snapshot.status != SessionStatus::Recording {
            store.snapshot.status = SessionStatus::Mirroring;
        }
        store.receiver_runtime.state = ReceiverRuntimeState::Streaming;
        store.receiver_runtime.queued_segments = store.live_preview_buffer.queued_segment_count();
        store.receiver_runtime.last_error = None;
    } else {
        store.snapshot.status = SessionStatus::Connecting;
        store.receiver_runtime.state = ReceiverRuntimeState::Ready;
        store.receiver_runtime.queued_segments = store.live_preview_buffer.queued_segment_count();
        store.receiver_runtime.last_error = Some(String::from(
            "receiver approved; waiting for the first decodable video frame from the iPhone",
        ));
    }

    sync_preview_diagnostics(store);
    clear_pairing(store);
}

pub(crate) fn reset_fixture_transport(store: &mut SessionStore) {
    let remux_blueprint = RemuxBlueprint::fixture_preview();
    store.preview_stream =
        preview_stream_from_blueprint(&remux_blueprint, ReceiverTransport::Fixture);
    store.live_preview_buffer.reset();
    store.remux_blueprint = remux_blueprint.clone();
    store.receiver_runtime.transport = ReceiverTransport::Fixture;
    store.receiver_runtime.stream_id = remux_blueprint.stream_id;
    reset_preview_diagnostics(store, ReceiverTransport::Fixture, true);
}

pub(crate) fn prepare_live_transport(store: &mut SessionStore, stream_id: String) {
    store.live_preview_buffer.reset();
    store.remux_blueprint = RemuxBlueprint::live_preview(stream_id.clone());
    store.preview_stream =
        preview_stream_from_blueprint(&store.remux_blueprint, ReceiverTransport::Airplayserver);
    store.receiver_runtime.transport = ReceiverTransport::Airplayserver;
    store.receiver_runtime.stream_id = stream_id;
    reset_preview_diagnostics(store, ReceiverTransport::Airplayserver, false);
}

pub(crate) fn refresh_live_preview_descriptor(store: &mut SessionStore) {
    store.preview_stream =
        preview_stream_from_blueprint(&store.remux_blueprint, ReceiverTransport::Airplayserver);
}

pub(crate) fn set_receiver_runtime_state(store: &mut SessionStore, state: ReceiverRuntimeState) {
    store.receiver_runtime.state = state;
    store.receiver_runtime.queued_segments = match state {
        ReceiverRuntimeState::Idle => 0,
        ReceiverRuntimeState::Priming => 1,
        ReceiverRuntimeState::Ready | ReceiverRuntimeState::Streaming => match store
            .receiver_runtime
            .transport
        {
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

#[cfg(test)]
mod tests {
    use super::{
        prepare_live_transport, resume_listening_after_disconnect, resume_local_session_approval,
        SessionStore,
    };
    use crate::models::{PairingEntryMode, PairingPhase, ReceiverRuntimeState, SessionStatus};

    const SAMPLE_SPS: [u8; 28] = [
        0x67, 0x42, 0xC0, 0x1E, 0xDA, 0x02, 0x80, 0xBF, 0xE5, 0xC0, 0x5A, 0x80, 0x80, 0x80, 0xA0,
        0x00, 0x00, 0x03, 0x00, 0x20, 0x00, 0x00, 0x07, 0x91, 0xE2, 0x85, 0x49, 0x01,
    ];
    const SAMPLE_PPS: [u8; 4] = [0x68, 0xCE, 0x0F, 0xC8];
    const SAMPLE_IDR: [u8; 5] = [0x65, 0x88, 0x84, 0x21, 0xA0];

    fn avcc_sample() -> Vec<u8> {
        let mut bytes = Vec::new();
        for nal in [&SAMPLE_SPS[..], &SAMPLE_PPS[..], &SAMPLE_IDR[..]] {
            bytes.extend_from_slice(&(nal.len() as u32).to_be_bytes());
            bytes.extend_from_slice(nal);
        }
        bytes
    }

    #[test]
    fn ask_mode_allow_starts_preview_when_video_was_buffered() {
        let mut store = SessionStore::default();
        prepare_live_transport(&mut store, String::from("airplay-stream-0001"));

        store.snapshot.status = SessionStatus::Connecting;
        store.require_local_session_approval = true;
        store.pending_local_session_approval = true;
        store.pairing.phase = PairingPhase::AwaitingTrust;
        store.pairing.entry_mode = PairingEntryMode::ConfirmOnly;
        store.pairing.can_trust = true;

        for index in 0..16u32 {
            store
                .live_preview_buffer
                .push_access_unit(
                    index,
                    avcc_sample(),
                    index == 0 || index == 15,
                    index as u64 * 3_000,
                    index as u64 * 3_000,
                    3_000,
                )
                .expect("buffer sample while approval is pending");
        }

        assert!(store.live_preview_buffer.queued_segment_count() > 0);
        assert!(matches!(store.snapshot.status, SessionStatus::Connecting));

        resume_local_session_approval(&mut store);

        assert!(matches!(store.snapshot.status, SessionStatus::Mirroring));
        assert!(matches!(
            store.receiver_runtime.state,
            ReceiverRuntimeState::Streaming
        ));
        assert!(store.live_preview_buffer.queued_segment_count() > 0);
        assert!(matches!(store.pairing.phase, PairingPhase::Idle));
        assert!(!store.pending_local_session_approval);
    }

    #[test]
    fn phone_disconnect_returns_the_running_receiver_to_listening() {
        let mut store = SessionStore {
            active_session_id: Some(String::from("session-1")),
            require_local_session_approval: true,
            require_known_device: true,
            native_pairing_approved_for_session: true,
            ..SessionStore::default()
        };
        store.snapshot.status = SessionStatus::Mirroring;
        store.snapshot.device_name = String::from("Max's iPhone");
        store.snapshot.current_device_id = Some(String::from("device-1"));
        store.snapshot.receiver_id = Some(String::from("MirrorSim"));
        store.snapshot.receiver_protocol_version = Some(String::from("0.4.0"));
        store.snapshot.receiver_capabilities = vec![String::from("native-receiver-process")];
        store.pairing.phase = PairingPhase::Paired;
        store.preview.frame_number = 42;

        resume_listening_after_disconnect(&mut store, String::from("stream-1"));

        assert!(matches!(store.snapshot.status, SessionStatus::Discovering));
        assert_eq!(store.active_session_id.as_deref(), Some("session-1"));
        assert_eq!(store.snapshot.device_name, "Waiting for iPhone");
        assert!(store.snapshot.current_device_id.is_none());
        assert_eq!(store.snapshot.receiver_id.as_deref(), Some("MirrorSim"));
        assert_eq!(
            store.snapshot.receiver_capabilities,
            vec![String::from("native-receiver-process")]
        );
        assert!(store.require_local_session_approval);
        assert!(store.require_known_device);
        assert!(!store.native_pairing_approved_for_session);
        assert!(matches!(store.pairing.phase, PairingPhase::Idle));
        assert_eq!(store.preview.frame_number, 0);
        assert!(matches!(
            store.receiver_runtime.state,
            ReceiverRuntimeState::Ready
        ));
        assert!(store.receiver_runtime.last_error.is_none());
    }
}
