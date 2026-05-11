use crate::remux::{
    AccessUnitTiming, AvcTrackConfig, FragmentedMp4SegmentDescriptor, H264AccessUnitDescriptor,
};
use std::collections::VecDeque;

const TRACK_ID: u32 = 1;
const MIN_SEGMENT_SAMPLES: usize = 4;
const MAX_QUEUED_SEGMENTS: usize = 45;
const LIVE_TRACK_TIMESCALE: u32 = 1_000_000;
const DEFAULT_PREVIEW_SAMPLE_DURATION: u32 = 16_667;
const MAX_PREVIEW_SAMPLE_DURATION: u32 = 50_000;

#[derive(Clone)]
struct EncodedAccessUnit {
    descriptor: H264AccessUnitDescriptor,
    payload: Vec<u8>,
}

#[derive(Clone)]
pub struct QueuedPreviewSegment {
    pub descriptor: FragmentedMp4SegmentDescriptor,
    pub bytes: Vec<u8>,
}

pub struct PreviewPushResult {
    pub init_segment_became_available: bool,
    pub sample_enqueued: bool,
    pub emitted_segment: Option<FragmentedMp4SegmentDescriptor>,
}

struct ParsedH264Payload {
    parameter_sets: Option<(Vec<u8>, Vec<u8>)>,
    sample_payload: Option<Vec<u8>>,
    contains_idr: bool,
}

pub struct LivePreviewBuffer {
    track: Option<AvcTrackConfig>,
    init_segment: Option<Vec<u8>>,
    pending_samples: Vec<EncodedAccessUnit>,
    emitted_segments: VecDeque<QueuedPreviewSegment>,
    next_sequence_number: u32,
    last_emitted_segment: Option<FragmentedMp4SegmentDescriptor>,
    next_media_timestamp: u64,
}

impl LivePreviewBuffer {
    pub fn new() -> Self {
        Self {
            track: None,
            init_segment: None,
            pending_samples: Vec::new(),
            emitted_segments: VecDeque::new(),
            next_sequence_number: 1,
            last_emitted_segment: None,
            next_media_timestamp: 0,
        }
    }

    pub fn reset(&mut self) {
        *self = Self::new();
    }

    pub fn track_config(&self) -> Option<AvcTrackConfig> {
        self.track.clone()
    }

    pub fn init_segment_bytes(&self) -> Option<Vec<u8>> {
        self.init_segment.clone()
    }

    pub fn take_next_segment(&mut self) -> Option<QueuedPreviewSegment> {
        self.emitted_segments.pop_front()
    }

    pub fn queued_segment_count(&self) -> usize {
        self.emitted_segments.len()
    }

    pub fn pending_sample_count(&self) -> usize {
        self.pending_samples.len()
    }

    pub fn has_init_segment(&self) -> bool {
        self.init_segment.is_some()
    }

    pub fn last_emitted_segment_descriptor(&self) -> Option<FragmentedMp4SegmentDescriptor> {
        self.last_emitted_segment.clone()
    }

    pub fn push_access_unit(
        &mut self,
        sample_index: u32,
        payload: Vec<u8>,
        _is_keyframe: bool,
        _decode_timestamp: u64,
        _presentation_timestamp: u64,
        duration: u32,
    ) -> Result<PreviewPushResult, String> {
        let mut init_segment_became_available = false;
        let mut emitted_segment = None;
        let parsed_payload = parse_h264_payload(&payload);

        if let Some((track, init_segment)) =
            track_config_from_parameter_sets(parsed_payload.parameter_sets.as_ref())
        {
            let config_changed = self.track.as_ref().is_some_and(|current| {
                current.codec != track.codec
                    || current.width != track.width
                    || current.height != track.height
                    || current.decoder_config_hex != track.decoder_config_hex
            });

            if self.init_segment.is_none() || config_changed {
                if config_changed {
                    self.pending_samples.clear();
                    self.emitted_segments.clear();
                    self.next_sequence_number = 1;
                    self.last_emitted_segment = None;
                    self.next_media_timestamp = 0;
                }

                self.track = Some(track);
                self.init_segment = Some(init_segment);
                init_segment_became_available = true;
            }
        }

        if self.track.is_none() {
            return Ok(PreviewPushResult {
                init_segment_became_available,
                sample_enqueued: false,
                emitted_segment,
            });
        }

        let sample_payload = match parsed_payload.sample_payload {
            Some(sample_payload) => sample_payload,
            None => {
                return Ok(PreviewPushResult {
                    init_segment_became_available,
                    sample_enqueued: false,
                    emitted_segment,
                });
            }
        };

        let is_random_access = parsed_payload.contains_idr;
        let requires_random_access =
            self.next_sequence_number == 1 && self.pending_samples.is_empty();
        if requires_random_access && !is_random_access {
            return Ok(PreviewPushResult {
                init_segment_became_available,
                sample_enqueued: false,
                emitted_segment,
            });
        }

        let effective_duration = normalize_preview_sample_duration(duration);
        let preview_timestamp = self.next_media_timestamp;
        self.next_media_timestamp += effective_duration as u64;

        let descriptor = H264AccessUnitDescriptor {
            sample_index,
            size_bytes: sample_payload.len(),
            is_keyframe: is_random_access,
            timing: AccessUnitTiming {
                decode_timestamp: preview_timestamp,
                presentation_timestamp: preview_timestamp,
                duration: effective_duration,
            },
        };

        let should_flush_before_push =
            is_random_access && self.pending_samples.len() >= MIN_SEGMENT_SAMPLES;
        if should_flush_before_push {
            if self.flush_pending_segment()? {
                emitted_segment = self.last_emitted_segment_descriptor();
            }
        }

        self.pending_samples.push(EncodedAccessUnit {
            descriptor,
            payload: sample_payload,
        });

        if self.pending_samples.len() >= MIN_SEGMENT_SAMPLES {
            if self.flush_pending_segment()? {
                emitted_segment = self.last_emitted_segment_descriptor();
            }
        }

        Ok(PreviewPushResult {
            init_segment_became_available,
            sample_enqueued: true,
            emitted_segment,
        })
    }

    pub fn flush_pending_segment(&mut self) -> Result<bool, String> {
        if self.pending_samples.is_empty() {
            return Ok(false);
        }

        let segment = build_media_segment(self.next_sequence_number, &self.pending_samples)?;
        self.next_sequence_number += 1;
        self.last_emitted_segment = Some(segment.descriptor.clone());
        self.emitted_segments.push_back(segment);
        while self.emitted_segments.len() > MAX_QUEUED_SEGMENTS {
            self.emitted_segments.pop_front();
        }
        self.pending_samples.clear();
        Ok(true)
    }
}

pub(crate) fn normalize_preview_sample_duration(duration: u32) -> u32 {
    duration.clamp(DEFAULT_PREVIEW_SAMPLE_DURATION, MAX_PREVIEW_SAMPLE_DURATION)
}

fn track_config_from_parameter_sets(
    parameter_sets: Option<&(Vec<u8>, Vec<u8>)>,
) -> Option<(AvcTrackConfig, Vec<u8>)> {
    let (sps, pps) = parameter_sets?;
    let avcc = build_avcc(&sps, &pps);
    let (width, height) = parse_sps_dimensions(&sps).unwrap_or((393, 852));
    let codec = if sps.len() >= 4 {
        format!("avc1.{:02x}{:02x}{:02x}", sps[1], sps[2], sps[3])
    } else {
        String::from("avc1.42c01e")
    };

    let track = AvcTrackConfig {
        codec: codec.clone(),
        width,
        height,
        timescale: LIVE_TRACK_TIMESCALE,
        decoder_config_hex: avcc.iter().map(|byte| format!("{:02x}", byte)).collect(),
    };

    let init_segment = build_init_segment(&track, &avcc);
    Some((track, init_segment))
}

fn parse_h264_payload(payload: &[u8]) -> ParsedH264Payload {
    if let Some(nals) = parse_annex_b_nals(payload) {
        return parsed_payload_from_nals(nals);
    }

    if let Some(nals) = parse_avcc_nals(payload) {
        return parsed_payload_from_nals(nals);
    }

    ParsedH264Payload {
        parameter_sets: None,
        sample_payload: None,
        contains_idr: false,
    }
}

fn parsed_payload_from_nals(nals: Vec<Vec<u8>>) -> ParsedH264Payload {
    let mut sps = None;
    let mut pps = None;
    let mut sample_nals = Vec::new();
    let mut contains_idr = false;

    for nal in nals {
        if nal.is_empty() {
            continue;
        }

        match nal[0] & 0x1f {
            7 => {
                if sps.is_none() {
                    sps = Some(nal);
                }
            }
            8 => {
                if pps.is_none() {
                    pps = Some(nal);
                }
            }
            5 => {
                contains_idr = true;
                sample_nals.push(nal);
            }
            9 => {}
            _ => sample_nals.push(nal),
        }
    }

    ParsedH264Payload {
        parameter_sets: sps.zip(pps),
        sample_payload: (!sample_nals.is_empty()).then(|| avcc_payload_from_nals(&sample_nals)),
        contains_idr,
    }
}

fn parse_annex_b_nals(payload: &[u8]) -> Option<Vec<Vec<u8>>> {
    let mut positions = Vec::new();
    let mut index = 0usize;

    while index + 3 < payload.len() {
        let start_code_len = if payload[index..].starts_with(&[0, 0, 0, 1]) {
            4
        } else if payload[index..].starts_with(&[0, 0, 1]) {
            3
        } else {
            index += 1;
            continue;
        };

        positions.push((index, start_code_len));
        index += start_code_len;
    }

    if positions.is_empty() {
        return None;
    }

    let mut nals = Vec::new();
    for (entry_index, (start, start_code_len)) in positions.iter().enumerate() {
        let nal_start = start + start_code_len;
        let nal_end = positions
            .get(entry_index + 1)
            .map(|(next_start, _)| *next_start)
            .unwrap_or(payload.len());

        if nal_end > nal_start {
            nals.push(payload[nal_start..nal_end].to_vec());
        }
    }

    Some(nals)
}

fn parse_avcc_nals(payload: &[u8]) -> Option<Vec<Vec<u8>>> {
    let mut cursor = 0usize;
    let mut nals = Vec::new();

    while cursor + 4 <= payload.len() {
        let length = u32::from_be_bytes([
            payload[cursor],
            payload[cursor + 1],
            payload[cursor + 2],
            payload[cursor + 3],
        ]) as usize;
        cursor += 4;

        if length == 0 || cursor + length > payload.len() {
            return None;
        }

        nals.push(payload[cursor..cursor + length].to_vec());
        cursor += length;
    }

    if cursor != payload.len() || nals.is_empty() {
        return None;
    }

    Some(nals)
}

fn avcc_payload_from_nals(nals: &[Vec<u8>]) -> Vec<u8> {
    let total_len = nals.iter().map(|nal| nal.len() + 4).sum();
    let mut payload = Vec::with_capacity(total_len);

    for nal in nals {
        payload.extend_from_slice(&(nal.len() as u32).to_be_bytes());
        payload.extend_from_slice(nal);
    }

    payload
}

#[cfg(test)]
fn extract_parameter_sets(payload: &[u8]) -> Option<(Vec<u8>, Vec<u8>)> {
    parse_h264_payload(payload).parameter_sets
}

fn build_avcc(sps: &[u8], pps: &[u8]) -> Vec<u8> {
    let mut bytes = vec![
        1,
        *sps.get(1).unwrap_or(&0x42),
        *sps.get(2).unwrap_or(&0xC0),
        *sps.get(3).unwrap_or(&0x1E),
        0xFF,
        0xE1,
    ];
    bytes.extend_from_slice(&(sps.len() as u16).to_be_bytes());
    bytes.extend_from_slice(sps);
    bytes.push(1);
    bytes.extend_from_slice(&(pps.len() as u16).to_be_bytes());
    bytes.extend_from_slice(pps);
    bytes
}

fn build_init_segment(track: &AvcTrackConfig, avcc: &[u8]) -> Vec<u8> {
    concat_bytes(&[ftyp_box(), moov_box(track, avcc)])
}

fn build_media_segment(
    sequence_number: u32,
    samples: &[EncodedAccessUnit],
) -> Result<QueuedPreviewSegment, String> {
    let first_sample = samples
        .first()
        .ok_or_else(|| String::from("cannot build a media segment without samples"))?;
    let last_sample = samples
        .last()
        .ok_or_else(|| String::from("cannot build a media segment without samples"))?;

    let base_decode_time = first_sample.descriptor.timing.decode_timestamp;
    let mdat_payload = samples
        .iter()
        .flat_map(|sample| sample.payload.iter().copied())
        .collect::<Vec<_>>();
    let mdat = boxed(*b"mdat", mdat_payload.clone());
    let moof = moof_box(
        sequence_number,
        base_decode_time,
        samples,
        8 + estimate_moof_size(samples.len()),
    );

    Ok(QueuedPreviewSegment {
        descriptor: FragmentedMp4SegmentDescriptor {
            sequence_number,
            file_path: format!("memory://live-preview/segment-{:05}.m4s", sequence_number),
            first_sample_index: first_sample.descriptor.sample_index,
            last_sample_index: last_sample.descriptor.sample_index,
            decode_time: base_decode_time,
            duration: samples
                .iter()
                .map(|sample| sample.descriptor.timing.duration)
                .sum(),
            starts_with_keyframe: first_sample.descriptor.is_keyframe,
        },
        bytes: concat_bytes(&[moof, mdat]),
    })
}

fn estimate_moof_size(sample_count: usize) -> i32 {
    let mfhd = 16usize;
    let tfhd = 16usize;
    let tfdt = 20usize;
    let trun = 20usize + sample_count * 16usize;
    let traf = 8usize + tfhd + tfdt + trun;
    let moof = 8usize + mfhd + traf;
    moof as i32
}

fn ftyp_box() -> Vec<u8> {
    let mut payload = Vec::new();
    payload.extend_from_slice(b"isom");
    payload.extend_from_slice(&512_u32.to_be_bytes());
    payload.extend_from_slice(b"isomiso6mp41");
    boxed(*b"ftyp", payload)
}

fn moov_box(track: &AvcTrackConfig, avcc: &[u8]) -> Vec<u8> {
    boxed(
        *b"moov",
        concat_bytes(&[mvhd_box(track.timescale), trak_box(track, avcc), mvex_box()]),
    )
}

fn mvhd_box(timescale: u32) -> Vec<u8> {
    let mut payload = Vec::new();
    payload.extend_from_slice(&0_u32.to_be_bytes());
    payload.extend_from_slice(&0_u32.to_be_bytes());
    payload.extend_from_slice(&timescale.to_be_bytes());
    payload.extend_from_slice(&0_u32.to_be_bytes());
    payload.extend_from_slice(&0x0001_0000_u32.to_be_bytes());
    payload.extend_from_slice(&0x0100_u16.to_be_bytes());
    payload.extend_from_slice(&0_u16.to_be_bytes());
    payload.extend_from_slice(&[0; 8]);
    payload.extend_from_slice(&[
        0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
        0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
        0x00, 0x00, 0x40, 0x00, 0x00, 0x00,
    ]);
    payload.extend_from_slice(&[0; 24]);
    payload.extend_from_slice(&2_u32.to_be_bytes());
    full_box(*b"mvhd", 0, 0, payload)
}

fn trak_box(track: &AvcTrackConfig, avcc: &[u8]) -> Vec<u8> {
    boxed(
        *b"trak",
        concat_bytes(&[tkhd_box(track), mdia_box(track, avcc)]),
    )
}

fn tkhd_box(track: &AvcTrackConfig) -> Vec<u8> {
    let mut payload = Vec::new();
    payload.extend_from_slice(&0_u32.to_be_bytes());
    payload.extend_from_slice(&0_u32.to_be_bytes());
    payload.extend_from_slice(&TRACK_ID.to_be_bytes());
    payload.extend_from_slice(&0_u32.to_be_bytes());
    payload.extend_from_slice(&0_u32.to_be_bytes());
    payload.extend_from_slice(&[0; 8]);
    payload.extend_from_slice(&0_u16.to_be_bytes());
    payload.extend_from_slice(&0_u16.to_be_bytes());
    payload.extend_from_slice(&0_u16.to_be_bytes());
    payload.extend_from_slice(&0_u16.to_be_bytes());
    payload.extend_from_slice(&[
        0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
        0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
        0x00, 0x00, 0x40, 0x00, 0x00, 0x00,
    ]);
    payload.extend_from_slice(&((track.width as u32) << 16).to_be_bytes());
    payload.extend_from_slice(&((track.height as u32) << 16).to_be_bytes());
    full_box(*b"tkhd", 0, 0x000007, payload)
}

fn mdia_box(track: &AvcTrackConfig, avcc: &[u8]) -> Vec<u8> {
    boxed(
        *b"mdia",
        concat_bytes(&[
            mdhd_box(track.timescale),
            hdlr_box(*b"vide", b"VideoHandler\0"),
            minf_box(track, avcc),
        ]),
    )
}

fn mdhd_box(timescale: u32) -> Vec<u8> {
    let mut payload = Vec::new();
    payload.extend_from_slice(&0_u32.to_be_bytes());
    payload.extend_from_slice(&0_u32.to_be_bytes());
    payload.extend_from_slice(&timescale.to_be_bytes());
    payload.extend_from_slice(&0_u32.to_be_bytes());
    payload.extend_from_slice(&0x55C4_u16.to_be_bytes());
    payload.extend_from_slice(&0_u16.to_be_bytes());
    full_box(*b"mdhd", 0, 0, payload)
}

fn hdlr_box(handler_type: [u8; 4], name: &[u8]) -> Vec<u8> {
    let mut payload = Vec::new();
    payload.extend_from_slice(&0_u32.to_be_bytes());
    payload.extend_from_slice(&handler_type);
    payload.extend_from_slice(&[0; 12]);
    payload.extend_from_slice(name);
    full_box(*b"hdlr", 0, 0, payload)
}

fn minf_box(track: &AvcTrackConfig, avcc: &[u8]) -> Vec<u8> {
    boxed(
        *b"minf",
        concat_bytes(&[vmhd_box(), dinf_box(), stbl_box(track, avcc)]),
    )
}

fn vmhd_box() -> Vec<u8> {
    let mut payload = Vec::new();
    payload.extend_from_slice(&0_u16.to_be_bytes());
    payload.extend_from_slice(&0_u16.to_be_bytes());
    payload.extend_from_slice(&0_u16.to_be_bytes());
    payload.extend_from_slice(&0_u16.to_be_bytes());
    full_box(*b"vmhd", 0, 1, payload)
}

fn dinf_box() -> Vec<u8> {
    boxed(*b"dinf", dref_box())
}

fn dref_box() -> Vec<u8> {
    let url = full_box(*b"url ", 0, 1, Vec::new());
    let mut payload = Vec::new();
    payload.extend_from_slice(&1_u32.to_be_bytes());
    payload.extend_from_slice(&url);
    full_box(*b"dref", 0, 0, payload)
}

fn stbl_box(track: &AvcTrackConfig, avcc: &[u8]) -> Vec<u8> {
    boxed(
        *b"stbl",
        concat_bytes(&[
            stsd_box(track, avcc),
            empty_table_box(*b"stts"),
            empty_table_box(*b"stsc"),
            stsz_box(),
            empty_table_box(*b"stco"),
        ]),
    )
}

fn stsd_box(track: &AvcTrackConfig, avcc: &[u8]) -> Vec<u8> {
    let avc1 = avc1_box(track, avcc);
    let mut payload = Vec::new();
    payload.extend_from_slice(&1_u32.to_be_bytes());
    payload.extend_from_slice(&avc1);
    full_box(*b"stsd", 0, 0, payload)
}

fn avc1_box(track: &AvcTrackConfig, avcc: &[u8]) -> Vec<u8> {
    let mut payload = Vec::new();
    payload.extend_from_slice(&[0; 6]);
    payload.extend_from_slice(&1_u16.to_be_bytes());
    payload.extend_from_slice(&[0; 16]);
    payload.extend_from_slice(&track.width.to_be_bytes());
    payload.extend_from_slice(&track.height.to_be_bytes());
    payload.extend_from_slice(&0x0048_0000_u32.to_be_bytes());
    payload.extend_from_slice(&0x0048_0000_u32.to_be_bytes());
    payload.extend_from_slice(&0_u32.to_be_bytes());
    payload.extend_from_slice(&1_u16.to_be_bytes());
    payload.extend_from_slice(&[0; 32]);
    payload.extend_from_slice(&0x0018_u16.to_be_bytes());
    payload.extend_from_slice(&0xFFFF_u16.to_be_bytes());
    payload.extend_from_slice(&boxed(*b"avcC", avcc.to_vec()));
    boxed(*b"avc1", payload)
}

fn empty_table_box(name: [u8; 4]) -> Vec<u8> {
    let mut payload = Vec::new();
    payload.extend_from_slice(&0_u32.to_be_bytes());
    full_box(name, 0, 0, payload)
}

fn stsz_box() -> Vec<u8> {
    let mut payload = Vec::new();
    payload.extend_from_slice(&0_u32.to_be_bytes());
    payload.extend_from_slice(&0_u32.to_be_bytes());
    full_box(*b"stsz", 0, 0, payload)
}

fn mvex_box() -> Vec<u8> {
    boxed(*b"mvex", trex_box())
}

fn trex_box() -> Vec<u8> {
    let mut payload = Vec::new();
    payload.extend_from_slice(&TRACK_ID.to_be_bytes());
    payload.extend_from_slice(&1_u32.to_be_bytes());
    payload.extend_from_slice(&0_u32.to_be_bytes());
    payload.extend_from_slice(&0_u32.to_be_bytes());
    payload.extend_from_slice(&0_u32.to_be_bytes());
    full_box(*b"trex", 0, 0, payload)
}

fn moof_box(
    sequence_number: u32,
    base_decode_time: u64,
    samples: &[EncodedAccessUnit],
    data_offset: i32,
) -> Vec<u8> {
    boxed(
        *b"moof",
        concat_bytes(&[
            mfhd_box(sequence_number),
            traf_box(base_decode_time, samples, data_offset),
        ]),
    )
}

fn mfhd_box(sequence_number: u32) -> Vec<u8> {
    let mut payload = Vec::new();
    payload.extend_from_slice(&sequence_number.to_be_bytes());
    full_box(*b"mfhd", 0, 0, payload)
}

fn traf_box(base_decode_time: u64, samples: &[EncodedAccessUnit], data_offset: i32) -> Vec<u8> {
    boxed(
        *b"traf",
        concat_bytes(&[
            tfhd_box(),
            tfdt_box(base_decode_time),
            trun_box(samples, data_offset),
        ]),
    )
}

fn tfhd_box() -> Vec<u8> {
    let mut payload = Vec::new();
    payload.extend_from_slice(&TRACK_ID.to_be_bytes());
    full_box(*b"tfhd", 0, 0x020000, payload)
}

fn tfdt_box(base_decode_time: u64) -> Vec<u8> {
    let mut payload = Vec::new();
    payload.extend_from_slice(&base_decode_time.to_be_bytes());
    full_box(*b"tfdt", 1, 0, payload)
}

fn trun_box(samples: &[EncodedAccessUnit], data_offset: i32) -> Vec<u8> {
    let mut payload = Vec::new();
    payload.extend_from_slice(&(samples.len() as u32).to_be_bytes());
    payload.extend_from_slice(&data_offset.to_be_bytes());

    for sample in samples {
        payload.extend_from_slice(&sample.descriptor.timing.duration.to_be_bytes());
        payload.extend_from_slice(&(sample.payload.len() as u32).to_be_bytes());
        payload.extend_from_slice(&sample_flags(sample.descriptor.is_keyframe).to_be_bytes());
        let composition_offset = sample
            .descriptor
            .timing
            .presentation_timestamp
            .saturating_sub(sample.descriptor.timing.decode_timestamp)
            as u32;
        payload.extend_from_slice(&composition_offset.to_be_bytes());
    }

    full_box(*b"trun", 0, 0x000F01, payload)
}

fn sample_flags(is_keyframe: bool) -> u32 {
    if is_keyframe {
        0x0200_0000
    } else {
        0x0101_0000
    }
}

fn full_box(name: [u8; 4], version: u8, flags: u32, payload: Vec<u8>) -> Vec<u8> {
    let mut full_payload = Vec::with_capacity(payload.len() + 4);
    full_payload.push(version);
    full_payload.extend_from_slice(&[(flags >> 16) as u8, (flags >> 8) as u8, flags as u8]);
    full_payload.extend_from_slice(&payload);
    boxed(name, full_payload)
}

fn boxed(name: [u8; 4], payload: Vec<u8>) -> Vec<u8> {
    let size = (payload.len() + 8) as u32;
    let mut bytes = Vec::with_capacity(payload.len() + 8);
    bytes.extend_from_slice(&size.to_be_bytes());
    bytes.extend_from_slice(&name);
    bytes.extend_from_slice(&payload);
    bytes
}

fn concat_bytes(parts: &[Vec<u8>]) -> Vec<u8> {
    let total = parts.iter().map(Vec::len).sum();
    let mut bytes = Vec::with_capacity(total);
    for part in parts {
        bytes.extend_from_slice(part);
    }
    bytes
}

struct BitReader {
    bytes: Vec<u8>,
    bit_offset: usize,
}

impl BitReader {
    fn new(nal: &[u8]) -> Self {
        let mut rbsp = Vec::with_capacity(nal.len());
        let mut zero_count = 0usize;

        for (index, byte) in nal.iter().enumerate() {
            if index == 0 {
                continue;
            }

            if zero_count == 2 && *byte == 0x03 {
                zero_count = 0;
                continue;
            }

            rbsp.push(*byte);
            zero_count = if *byte == 0 { zero_count + 1 } else { 0 };
        }

        Self {
            bytes: rbsp,
            bit_offset: 0,
        }
    }

    fn read_bit(&mut self) -> Option<u8> {
        if self.bit_offset / 8 >= self.bytes.len() {
            return None;
        }

        let byte = self.bytes[self.bit_offset / 8];
        let shift = 7 - (self.bit_offset % 8);
        self.bit_offset += 1;
        Some((byte >> shift) & 1)
    }

    fn read_bits(&mut self, count: usize) -> Option<u32> {
        let mut value = 0u32;
        for _ in 0..count {
            value = (value << 1) | u32::from(self.read_bit()?);
        }
        Some(value)
    }

    fn read_ue(&mut self) -> Option<u32> {
        let mut leading_zero_bits = 0usize;
        while self.read_bit()? == 0 {
            leading_zero_bits += 1;
        }

        let suffix = if leading_zero_bits == 0 {
            0
        } else {
            self.read_bits(leading_zero_bits)?
        };
        Some(((1u32 << leading_zero_bits) - 1) + suffix)
    }

    fn read_se(&mut self) -> Option<i32> {
        let code_num = self.read_ue()? as i32;
        if code_num % 2 == 0 {
            Some(-(code_num / 2))
        } else {
            Some((code_num + 1) / 2)
        }
    }
}

fn parse_sps_dimensions(sps: &[u8]) -> Option<(u16, u16)> {
    let mut reader = BitReader::new(sps);
    let profile_idc = reader.read_bits(8)? as u8;
    reader.read_bits(8)?;
    reader.read_bits(8)?;
    reader.read_ue()?;

    let mut chroma_format_idc = 1u32;
    if matches!(
        profile_idc,
        100 | 110 | 122 | 244 | 44 | 83 | 86 | 118 | 128 | 138 | 139 | 134 | 135
    ) {
        chroma_format_idc = reader.read_ue()?;
        if chroma_format_idc == 3 {
            reader.read_bit()?;
        }

        reader.read_ue()?;
        reader.read_ue()?;
        reader.read_bit()?;

        if reader.read_bit()? == 1 {
            let scaling_list_count = if chroma_format_idc != 3 { 8 } else { 12 };
            for index in 0..scaling_list_count {
                if reader.read_bit()? == 1 {
                    skip_scaling_list(&mut reader, if index < 6 { 16 } else { 64 })?;
                }
            }
        }
    }

    reader.read_ue()?;
    let pic_order_cnt_type = reader.read_ue()?;
    if pic_order_cnt_type == 0 {
        reader.read_ue()?;
    } else if pic_order_cnt_type == 1 {
        reader.read_bit()?;
        reader.read_se()?;
        reader.read_se()?;
        let cycle = reader.read_ue()?;
        for _ in 0..cycle {
            reader.read_se()?;
        }
    }

    reader.read_ue()?;
    reader.read_bit()?;
    let pic_width_in_mbs_minus1 = reader.read_ue()?;
    let pic_height_in_map_units_minus1 = reader.read_ue()?;
    let frame_mbs_only_flag = reader.read_bit()?;
    if frame_mbs_only_flag == 0 {
        reader.read_bit()?;
    }

    reader.read_bit()?;
    let frame_cropping_flag = reader.read_bit()?;

    let (crop_left, crop_right, crop_top, crop_bottom) = if frame_cropping_flag == 1 {
        (
            reader.read_ue()?,
            reader.read_ue()?,
            reader.read_ue()?,
            reader.read_ue()?,
        )
    } else {
        (0, 0, 0, 0)
    };

    let frame_height_in_mbs =
        (2 - u32::from(frame_mbs_only_flag)) * (pic_height_in_map_units_minus1 + 1);
    let mut width = (pic_width_in_mbs_minus1 + 1) * 16;
    let mut height = frame_height_in_mbs * 16;

    let (crop_unit_x, crop_unit_y) = match chroma_format_idc {
        0 => (1, 2 - u32::from(frame_mbs_only_flag)),
        1 => (2, 2 * (2 - u32::from(frame_mbs_only_flag))),
        2 => (2, 2 - u32::from(frame_mbs_only_flag)),
        3 => (1, 2 - u32::from(frame_mbs_only_flag)),
        _ => (1, 1),
    };

    width = width.saturating_sub((crop_left + crop_right) * crop_unit_x);
    height = height.saturating_sub((crop_top + crop_bottom) * crop_unit_y);

    Some((width as u16, height as u16))
}

fn skip_scaling_list(reader: &mut BitReader, size: usize) -> Option<()> {
    let mut last_scale = 8i32;
    let mut next_scale = 8i32;

    for _ in 0..size {
        if next_scale != 0 {
            let delta_scale = reader.read_se()?;
            next_scale = (last_scale + delta_scale + 256) % 256;
        }

        last_scale = if next_scale == 0 {
            last_scale
        } else {
            next_scale
        };
    }

    Some(())
}

#[cfg(test)]
mod tests {
    use super::{
        extract_parameter_sets, normalize_preview_sample_duration, parse_h264_payload,
        LivePreviewBuffer, DEFAULT_PREVIEW_SAMPLE_DURATION, MAX_PREVIEW_SAMPLE_DURATION,
        MAX_QUEUED_SEGMENTS,
    };

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

    fn avcc_sample_with_changed_decoder_config() -> Vec<u8> {
        let mut sps = SAMPLE_SPS;
        sps[3] = 0x1F;

        let mut bytes = Vec::new();
        for nal in [&sps[..], &SAMPLE_PPS[..], &SAMPLE_IDR[..]] {
            bytes.extend_from_slice(&(nal.len() as u32).to_be_bytes());
            bytes.extend_from_slice(nal);
        }
        bytes
    }

    fn annex_b_parameter_sets() -> Vec<u8> {
        let mut bytes = Vec::new();
        for nal in [&SAMPLE_SPS[..], &SAMPLE_PPS[..]] {
            bytes.extend_from_slice(&[0, 0, 0, 1]);
            bytes.extend_from_slice(nal);
        }
        bytes
    }

    fn annex_b_idr_sample() -> Vec<u8> {
        let mut bytes = Vec::new();
        bytes.extend_from_slice(&[0, 0, 0, 1]);
        bytes.extend_from_slice(&SAMPLE_IDR);
        bytes
    }

    fn avcc_non_idr_sample() -> Vec<u8> {
        let non_idr = [0x41, 0x9A, 0x22, 0x11];
        let mut bytes = Vec::new();
        bytes.extend_from_slice(&(non_idr.len() as u32).to_be_bytes());
        bytes.extend_from_slice(&non_idr);
        bytes
    }

    #[test]
    fn extracts_parameter_sets_from_avcc_sample() {
        let (sps, pps) = extract_parameter_sets(&avcc_sample()).expect("parameter sets");

        assert_eq!(sps, SAMPLE_SPS);
        assert_eq!(pps, SAMPLE_PPS);
    }

    #[test]
    fn emits_init_and_media_segments_from_live_samples() {
        let mut buffer = LivePreviewBuffer::new();

        let first = buffer
            .push_access_unit(0, avcc_sample(), true, 0, 0, 3_000)
            .expect("push first sample");
        assert!(first.init_segment_became_available);
        assert!(buffer.init_segment_bytes().is_some());

        for index in 1..16 {
            let result = buffer
                .push_access_unit(
                    index,
                    avcc_sample(),
                    index == 15,
                    index as u64 * 3_000,
                    index as u64 * 3_000,
                    3_000,
                )
                .expect("push sample");

            if index == 15 {
                assert!(!result.init_segment_became_available);
            }
        }

        let segment = buffer.take_next_segment().expect("queued media segment");
        assert_eq!(segment.descriptor.sequence_number, 1);
        assert_eq!(&segment.bytes[4..8], b"moof");
    }

    #[test]
    fn extracts_parameter_sets_from_annex_b_sample() {
        let (sps, pps) =
            extract_parameter_sets(&annex_b_parameter_sets()).expect("annex b parameter sets");

        assert_eq!(sps, SAMPLE_SPS);
        assert_eq!(pps, SAMPLE_PPS);
    }

    #[test]
    fn parses_annex_b_idr_as_sample_payload() {
        let parsed = parse_h264_payload(&annex_b_idr_sample());

        assert!(parsed.parameter_sets.is_none());
        assert!(parsed.contains_idr);
        let sample_payload = parsed.sample_payload.expect("sample payload");
        assert_eq!(
            u32::from_be_bytes(sample_payload[0..4].try_into().expect("length prefix")),
            SAMPLE_IDR.len() as u32
        );
        assert_eq!(&sample_payload[4..], &SAMPLE_IDR);
    }

    #[test]
    fn parameter_set_packet_does_not_enqueue_media_sample() {
        let mut buffer = LivePreviewBuffer::new();

        let result = buffer
            .push_access_unit(0, annex_b_parameter_sets(), true, 0, 0, 0)
            .expect("push parameter sets");

        assert!(result.init_segment_became_available);
        assert!(!result.sample_enqueued);
        assert!(buffer.init_segment_bytes().is_some());
        assert_eq!(buffer.queued_segment_count(), 0);
    }

    #[test]
    fn sidecar_keyframe_flag_without_idr_does_not_start_decoder_sequence() {
        let mut buffer = LivePreviewBuffer::new();

        buffer
            .push_access_unit(0, annex_b_parameter_sets(), true, 0, 0, 0)
            .expect("push parameter sets");
        let result = buffer
            .push_access_unit(1, avcc_non_idr_sample(), true, 0, 0, 3_000)
            .expect("push non-idr sample");

        assert!(!result.sample_enqueued);
        assert_eq!(buffer.pending_sample_count(), 0);
        assert_eq!(buffer.queued_segment_count(), 0);
    }

    #[test]
    fn changed_decoder_config_restarts_live_preview() {
        let mut buffer = LivePreviewBuffer::new();

        buffer
            .push_access_unit(0, avcc_sample(), true, 0, 0, 3_000)
            .expect("push initial sample");
        for index in 1..4 {
            buffer
                .push_access_unit(
                    index,
                    avcc_sample(),
                    false,
                    index as u64 * 3_000,
                    index as u64 * 3_000,
                    3_000,
                )
                .expect("push sample");
        }
        assert_eq!(buffer.queued_segment_count(), 1);

        let result = buffer
            .push_access_unit(
                4,
                avcc_sample_with_changed_decoder_config(),
                true,
                12_000,
                12_000,
                3_000,
            )
            .expect("push changed config");

        assert!(result.init_segment_became_available);
        assert!(result.sample_enqueued);
        assert_eq!(buffer.queued_segment_count(), 0);
        assert_eq!(buffer.pending_sample_count(), 1);
    }

    #[test]
    fn live_preview_queue_stays_near_live_edge() {
        let mut buffer = LivePreviewBuffer::new();

        for index in 0..240 {
            buffer
                .push_access_unit(
                    index,
                    avcc_sample(),
                    index % 30 == 0,
                    index as u64 * 3_000,
                    index as u64 * 3_000,
                    3_000,
                )
                .expect("push sample");
        }

        assert_eq!(buffer.queued_segment_count(), MAX_QUEUED_SEGMENTS);
        let segment = buffer.take_next_segment().expect("queued media segment");
        assert!(segment.descriptor.sequence_number > 1);
    }

    #[test]
    fn preview_sample_duration_is_clamped_for_live_playback() {
        assert_eq!(
            normalize_preview_sample_duration(0),
            DEFAULT_PREVIEW_SAMPLE_DURATION
        );
        assert_eq!(normalize_preview_sample_duration(33_333), 33_333);
        assert_eq!(
            normalize_preview_sample_duration(500_000),
            MAX_PREVIEW_SAMPLE_DURATION
        );
    }
}
