use serde::Serialize;

#[allow(dead_code)]
#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum SidecarProcessTransport {
    StdioJsonLines,
    NamedPipe,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SidecarLaunchSpec {
    pub executable: String,
    pub args: Vec<String>,
    pub working_directory: String,
    pub transport: SidecarProcessTransport,
    pub restart_on_crash: bool,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SidecarCommandSpec {
    pub name: String,
    pub payload_shape: String,
    pub description: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SidecarEventSpec {
    pub name: String,
    pub payload_shape: String,
    pub description: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VideoAccessUnitPacketSpec {
    pub codec: String,
    pub nal_unit_format: String,
    pub timestamp_units: String,
    pub includes_parameter_sets: bool,
    pub requires_keyframes_for_recovery: bool,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioPacketSpec {
    pub encoding: String,
    pub byte_order: String,
    pub interleaved: bool,
    pub timestamp_units: String,
    pub maximum_channels: u16,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReceiverSidecarSpec {
    pub protocol_version: String,
    pub launch: SidecarLaunchSpec,
    pub commands: Vec<SidecarCommandSpec>,
    pub events: Vec<SidecarEventSpec>,
    pub video_packet: VideoAccessUnitPacketSpec,
    pub audio_packet: AudioPacketSpec,
}

impl ReceiverSidecarSpec {
    pub fn direct_receiver_boundary() -> Self {
        Self {
            protocol_version: String::from("0.6.0"),
            launch: SidecarLaunchSpec {
                executable: String::from("receivers/AirPlayServer/MirrorSimAdapter.exe"),
                args: vec![],
                working_directory: String::from("receivers/AirPlayServer"),
                transport: SidecarProcessTransport::StdioJsonLines,
                restart_on_crash: true,
            },
            commands: vec![
                SidecarCommandSpec {
                    name: String::from("start_session"),
                    payload_shape: String::from("{ sessionId, deviceHint?, expectedStreamId, receiverName?, trustedDeviceIds[], blockedDeviceIds[] }"),
                    description: String::from("Start discovery or attach to a sender and begin a mirrored session."),
                },
                SidecarCommandSpec {
                    name: String::from("stop_session"),
                    payload_shape: String::from("{ sessionId }"),
                    description: String::from("Stop the active mirrored session and release network resources."),
                },
                SidecarCommandSpec {
                    name: String::from("confirm_pairing_trust"),
                    payload_shape: String::from("{ sessionId, challengeId, rememberDevice }"),
                    description: String::from("Approve exactly the pending sender challenge for the active receiver session."),
                },
                SidecarCommandSpec {
                    name: String::from("cancel_pairing"),
                    payload_shape: String::from("{ sessionId, challengeId }"),
                    description: String::from("Cancel the current pairing or trust challenge without closing the whole receiver runtime."),
                },
                SidecarCommandSpec {
                    name: String::from("request_keyframe"),
                    payload_shape: String::from("{ streamId, reason }"),
                    description: String::from("Optionally ask the receiver for a clean recovery point after discontinuity. Only send this when the receiver advertises the keyframe-request capability."),
                },
                SidecarCommandSpec {
                    name: String::from("shutdown"),
                    payload_shape: String::from("{}"),
                    description: String::from("Terminate the sidecar cleanly when the desktop app exits."),
                },
            ],
            events: vec![
                SidecarEventSpec {
                    name: String::from("receiver_ready"),
                    payload_shape: String::from("{ receiverId, protocolVersion, capabilities[] }"),
                    description: String::from("Announces that the sidecar is booted and ready to accept session commands."),
                },
                SidecarEventSpec {
                    name: String::from("session_started"),
                    payload_shape: String::from("{ sessionId, streamId, deviceName, deviceId?, deviceModel?, deviceOsName?, deviceOsVersion?, deviceOsBuildVersion?, deviceSourceVersion? }"),
                    description: String::from("Confirms that the receiver established a mirrored session and assigned a stream id."),
                },
                SidecarEventSpec {
                    name: String::from("pairing_state_changed"),
                    payload_shape: String::from("{ phase, entryMode?, sessionId, challengeId, deviceName?, deviceId?, displayPin?, prompt?, failureMessage?, canTrust? }"),
                    description: String::from("Reports PIN prompts, trust confirmation requests, verification progress, and pairing failures from the receiver runtime."),
                },
                SidecarEventSpec {
                    name: String::from("video_access_unit"),
                    payload_shape: String::from("{ streamId, sampleIndex, keyframe, pts, dts, duration, payloadBase64 }"),
                    description: String::from("Delivers one H.264 access unit for the remux boundary to package into fragments."),
                },
                SidecarEventSpec {
                    name: String::from("audio_frame"),
                    payload_shape: String::from("{ streamId, pts, sampleRate, channels, bitsPerSample, payloadBase64 }"),
                    description: String::from("Delivers one interleaved signed 16-bit PCM audio frame for local playback and recording."),
                },
                SidecarEventSpec {
                    name: String::from("stream_discontinuity"),
                    payload_shape: String::from("{ streamId, reason, requiresInitSegmentRefresh }"),
                    description: String::from("Signals timestamp resets, transport loss, or decoder config changes that require a remux reset."),
                },
                SidecarEventSpec {
                    name: String::from("receiver_error"),
                    payload_shape: String::from("{ code, message, recoverable }"),
                    description: String::from("Reports transport, pairing, or media errors from the sidecar runtime."),
                },
            ],
            video_packet: VideoAccessUnitPacketSpec {
                codec: String::from("h264-avcc"),
                nal_unit_format: String::from("length-prefixed"),
                timestamp_units: String::from("microseconds"),
                includes_parameter_sets: true,
                requires_keyframes_for_recovery: true,
            },
            audio_packet: AudioPacketSpec {
                encoding: String::from("signed-pcm-16"),
                byte_order: String::from("little-endian"),
                interleaved: true,
                timestamp_units: String::from("microseconds"),
                maximum_channels: 2,
            },
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{ReceiverSidecarSpec, SidecarProcessTransport};

    #[test]
    fn direct_receiver_boundary_prefers_stdio_jsonl() {
        let spec = ReceiverSidecarSpec::direct_receiver_boundary();

        assert_eq!(spec.protocol_version, "0.6.0");
        assert_eq!(
            spec.launch.transport,
            SidecarProcessTransport::StdioJsonLines
        );
        assert!(spec
            .events
            .iter()
            .any(|event| event.name == "video_access_unit"));
        assert!(spec.events.iter().any(|event| event.name == "audio_frame"));
        assert_eq!(spec.audio_packet.encoding, "signed-pcm-16");
        assert!(spec
            .commands
            .iter()
            .any(|command| command.name == "request_keyframe"));
        assert!(spec
            .events
            .iter()
            .any(|event| event.name == "pairing_state_changed"));
        assert!(spec
            .commands
            .iter()
            .any(|command| command.name == "confirm_pairing_trust"));
    }
}
