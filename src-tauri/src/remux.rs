use serde::Serialize;

const FIXTURE_FRAME_COUNT: usize = 120;
const FIXTURE_SEGMENT_COUNT: usize = 4;
const FIXTURE_SEGMENT_FRAME_COUNT: usize = FIXTURE_FRAME_COUNT / FIXTURE_SEGMENT_COUNT;
const FIXTURE_TIMESCALE: u32 = 90_000;
const FIXTURE_FRAME_DURATION: u32 = 3_000;
const LIVE_TIMESCALE: u32 = 1_000_000;
const MAX_LIVE_ACCESS_UNIT_DESCRIPTORS: usize = 600;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AvcTrackConfig {
    pub codec: String,
    pub width: u16,
    pub height: u16,
    pub timescale: u32,
    pub decoder_config_hex: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccessUnitTiming {
    pub decode_timestamp: u64,
    pub presentation_timestamp: u64,
    pub duration: u32,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct H264AccessUnitDescriptor {
    pub sample_index: u32,
    pub size_bytes: usize,
    pub is_keyframe: bool,
    pub timing: AccessUnitTiming,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FragmentedMp4SegmentDescriptor {
    pub sequence_number: u32,
    pub file_path: String,
    pub first_sample_index: u32,
    pub last_sample_index: u32,
    pub decode_time: u64,
    pub duration: u32,
    pub starts_with_keyframe: bool,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemuxBlueprint {
    pub stream_id: String,
    pub mime_type: String,
    pub track: AvcTrackConfig,
    pub init_segment_path: String,
    pub media_segments: Vec<FragmentedMp4SegmentDescriptor>,
    pub access_units: Vec<H264AccessUnitDescriptor>,
    pub should_loop: bool,
}

impl RemuxBlueprint {
    pub fn fixture_preview() -> Self {
        let access_units = (0..FIXTURE_FRAME_COUNT)
            .map(|frame_index| {
                let decode_timestamp = frame_index as u64 * FIXTURE_FRAME_DURATION as u64;
                let is_keyframe = frame_index % FIXTURE_SEGMENT_FRAME_COUNT == 0;

                H264AccessUnitDescriptor {
                    sample_index: frame_index as u32,
                    size_bytes: if is_keyframe {
                        16_384
                    } else {
                        4_096 + (frame_index % 7) * 192
                    },
                    is_keyframe,
                    timing: AccessUnitTiming {
                        decode_timestamp,
                        presentation_timestamp: decode_timestamp,
                        duration: FIXTURE_FRAME_DURATION,
                    },
                }
            })
            .collect::<Vec<_>>();

        let media_segments = (0..FIXTURE_SEGMENT_COUNT)
            .map(|segment_index| {
                let first_sample_index = segment_index * FIXTURE_SEGMENT_FRAME_COUNT;
                let last_sample_index = first_sample_index + FIXTURE_SEGMENT_FRAME_COUNT - 1;

                FragmentedMp4SegmentDescriptor {
                    sequence_number: (segment_index + 1) as u32,
                    file_path: format!(
                        "/fixtures/preview/chunk-stream0-{:05}.m4s",
                        segment_index + 1
                    ),
                    first_sample_index: first_sample_index as u32,
                    last_sample_index: last_sample_index as u32,
                    decode_time: first_sample_index as u64 * FIXTURE_FRAME_DURATION as u64,
                    duration: (FIXTURE_SEGMENT_FRAME_COUNT as u32) * FIXTURE_FRAME_DURATION,
                    starts_with_keyframe: true,
                }
            })
            .collect::<Vec<_>>();

        Self {
            stream_id: String::from("fixture-preview-stream"),
            mime_type: String::from("video/mp4; codecs=\"avc1.42c01e\""),
            track: AvcTrackConfig {
                codec: String::from("avc1.42c01e"),
                width: 392,
                height: 852,
                timescale: FIXTURE_TIMESCALE,
                decoder_config_hex: String::from("0142c01effe100196742c01eda0280bfe5c05a808080a0000003002000000791e2854901000468ce0fc8"),
            },
            init_segment_path: String::from("/fixtures/preview/init-stream0.m4s"),
            media_segments,
            access_units,
            should_loop: true,
        }
    }

    pub fn live_preview(stream_id: impl Into<String>) -> Self {
        Self {
            stream_id: stream_id.into(),
            mime_type: String::from("video/mp4; codecs=\"avc1.42c01e\""),
            track: AvcTrackConfig {
                codec: String::from("avc1.42c01e"),
                width: 0,
                height: 0,
                timescale: LIVE_TIMESCALE,
                decoder_config_hex: String::new(),
            },
            init_segment_path: String::new(),
            media_segments: Vec::new(),
            access_units: Vec::new(),
            should_loop: false,
        }
    }

    pub fn reset_live_preview(&mut self, stream_id: impl Into<String>) {
        *self = Self::live_preview(stream_id);
    }

    pub fn push_access_unit(
        &mut self,
        sample_index: u32,
        size_bytes: usize,
        is_keyframe: bool,
        decode_timestamp: u64,
        presentation_timestamp: u64,
        duration: u32,
    ) {
        self.access_units.push(H264AccessUnitDescriptor {
            sample_index,
            size_bytes,
            is_keyframe,
            timing: AccessUnitTiming {
                decode_timestamp,
                presentation_timestamp,
                duration,
            },
        });

        if !self.should_loop && self.access_units.len() > MAX_LIVE_ACCESS_UNIT_DESCRIPTORS {
            let overflow = self.access_units.len() - MAX_LIVE_ACCESS_UNIT_DESCRIPTORS;
            self.access_units.drain(0..overflow);
        }
    }

    pub fn buffered_access_unit_count(&self) -> usize {
        self.access_units.len()
    }

    pub fn queued_segment_count(&self) -> usize {
        self.media_segments.len()
    }
}

#[cfg(test)]
mod tests {
    use super::RemuxBlueprint;

    #[test]
    fn fixture_preview_blueprint_has_expected_counts() {
        let blueprint = RemuxBlueprint::fixture_preview();

        assert_eq!(blueprint.access_units.len(), 120);
        assert_eq!(blueprint.media_segments.len(), 4);
        assert_eq!(blueprint.track.timescale, 90_000);
        assert_eq!(blueprint.media_segments[0].first_sample_index, 0);
        assert_eq!(blueprint.media_segments[3].last_sample_index, 119);
    }

    #[test]
    fn fixture_preview_marks_segment_boundaries_as_keyframes() {
        let blueprint = RemuxBlueprint::fixture_preview();

        assert!(blueprint.access_units[0].is_keyframe);
        assert!(blueprint.access_units[30].is_keyframe);
        assert!(blueprint.access_units[60].is_keyframe);
        assert!(blueprint.access_units[90].is_keyframe);
        assert!(!blueprint.access_units[1].is_keyframe);
        assert_eq!(blueprint.media_segments[1].decode_time, 90_000);
    }

    #[test]
    fn live_preview_accumulates_access_units() {
        let mut blueprint = RemuxBlueprint::live_preview("live-stream");

        blueprint.push_access_unit(0, 12_000, true, 0, 0, 3_000);
        blueprint.push_access_unit(1, 4_800, false, 3_000, 3_000, 3_000);

        assert_eq!(blueprint.stream_id, "live-stream");
        assert_eq!(blueprint.buffered_access_unit_count(), 2);
        assert!(blueprint.media_segments.is_empty());
        assert_eq!(blueprint.access_units[0].size_bytes, 12_000);
    }

    #[test]
    fn live_preview_bounds_diagnostic_access_units() {
        let mut blueprint = RemuxBlueprint::live_preview("live-stream");

        for index in 0..1_000 {
            blueprint.push_access_unit(
                index,
                4_800,
                index % 60 == 0,
                index as u64,
                index as u64,
                16_667,
            );
        }

        assert_eq!(blueprint.buffered_access_unit_count(), 600);
        assert_eq!(blueprint.access_units[0].sample_index, 400);
        assert_eq!(blueprint.access_units[599].sample_index, 999);
    }

    #[test]
    fn live_preview_reset_clears_buffered_access_units() {
        let mut blueprint = RemuxBlueprint::live_preview("first-stream");
        blueprint.push_access_unit(0, 12_000, true, 0, 0, 3_000);

        blueprint.reset_live_preview("next-stream");

        assert_eq!(blueprint.stream_id, "next-stream");
        assert!(blueprint.access_units.is_empty());
        assert!(blueprint.media_segments.is_empty());
        assert!(!blueprint.should_loop);
    }
}
