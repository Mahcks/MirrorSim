//! Rewrites the live-streamed WebM that MediaRecorder produces into a file
//! with a duration, sized clusters, and a seek index (Cues).
//!
//! MediaRecorder writes the Segment and every Cluster with "unknown" sizes
//! and never adds a Duration or Cues, so players show no timeline and cannot
//! seek. Block data is copied unchanged; nothing is re-encoded.

use std::fs::File;
use std::io::{BufWriter, Read, Seek, SeekFrom, Write};
use std::path::Path;

const EBML_HEADER: u32 = 0x1A45_DFA3;
const SEGMENT: u32 = 0x1853_8067;
const SEEK_HEAD: u32 = 0x114D_9B74;
const SEEK: u32 = 0x4DBB;
const SEEK_ID: u32 = 0x53AB;
const SEEK_POSITION: u32 = 0x53AC;
const INFO: u32 = 0x1549_A966;
#[cfg(test)]
const TIMECODE_SCALE: u32 = 0x2A_D7B1;
const DURATION: u32 = 0x4489;
const TRACKS: u32 = 0x1654_AE6B;
const TRACK_ENTRY: u32 = 0xAE;
const TRACK_NUMBER: u32 = 0xD7;
const TRACK_TYPE: u32 = 0x83;
const CLUSTER: u32 = 0x1F43_B675;
const CLUSTER_TIMECODE: u32 = 0xE7;
const SIMPLE_BLOCK: u32 = 0xA3;
const BLOCK_GROUP: u32 = 0xA0;
const BLOCK: u32 = 0xA1;
const BLOCK_DURATION: u32 = 0x9B;
const REFERENCE_BLOCK: u32 = 0xFB;
const CUES: u32 = 0x1C53_BB6B;
const CUE_POINT: u32 = 0xBB;
const CUE_TIME: u32 = 0xB3;
const CUE_TRACK_POSITIONS: u32 = 0xB7;
const CUE_TRACK: u32 = 0xF7;
const CUE_CLUSTER_POSITION: u32 = 0xF1;
const VOID: u32 = 0xEC;

const TRACK_TYPE_VIDEO: u64 = 1;
const MAX_METADATA_BYTES: u64 = 16 << 20;
const MAX_CLUSTER_BYTES: u64 = 512 << 20;

type Result<T> = std::result::Result<T, String>;

/// Top-level Segment children that end an unknown-size Cluster.
fn is_segment_child(id: u32) -> bool {
    // Tags, Chapters and Attachments are the remaining Segment children.
    matches!(
        id,
        CLUSTER
            | CUES
            | INFO
            | TRACKS
            | SEEK_HEAD
            | EBML_HEADER
            | SEGMENT
            | 0x1254_C367
            | 0x1043_A770
            | 0x1941_A469
    )
}

#[derive(Clone, Copy)]
struct Element {
    id: u32,
    start: u64,
    data_start: u64,
    /// None for "unknown" sizes.
    size: Option<u64>,
}

struct Source {
    file: File,
    len: u64,
}

impl Source {
    fn read_at(&mut self, pos: u64, buf: &mut [u8]) -> Result<()> {
        self.file
            .seek(SeekFrom::Start(pos))
            .map_err(|error| error.to_string())?;
        self.file.read_exact(buf).map_err(|error| error.to_string())
    }

    fn read_range(&mut self, start: u64, end: u64, limit: u64) -> Result<Vec<u8>> {
        if end < start || end - start > limit {
            return Err(String::from("WebM element is unexpectedly large"));
        }
        let mut buf = vec![0u8; (end - start) as usize];
        self.read_at(start, &mut buf)?;
        Ok(buf)
    }

    fn element_at(&mut self, pos: u64) -> Result<Option<Element>> {
        let available = self.len.saturating_sub(pos).min(12) as usize;
        if available < 2 {
            return Ok(None);
        }
        let mut header = [0u8; 12];
        self.read_at(pos, &mut header[..available])?;
        let Some((id, id_len)) = read_id(&header[..available]) else {
            return Ok(None);
        };
        let Some((size, size_len)) = read_size(&header[id_len..available]) else {
            return Ok(None);
        };
        Ok(Some(Element {
            id,
            start: pos,
            data_start: pos + (id_len + size_len) as u64,
            size,
        }))
    }
}

fn vint_len(first: u8) -> Option<usize> {
    (first != 0).then_some(first.leading_zeros() as usize + 1)
}

fn read_id(data: &[u8]) -> Option<(u32, usize)> {
    let len = vint_len(*data.first()?)?;
    if len > 4 || data.len() < len {
        return None;
    }
    Some((
        data[..len]
            .iter()
            .fold(0u32, |acc, &byte| (acc << 8) | u32::from(byte)),
        len,
    ))
}

fn read_size(data: &[u8]) -> Option<(Option<u64>, usize)> {
    let len = vint_len(*data.first()?)?;
    if len > 8 || data.len() < len {
        return None;
    }
    let mut value = u64::from(data[0]) & ((1u64 << (8 - len)) - 1);
    for &byte in &data[1..len] {
        value = (value << 8) | u64::from(byte);
    }
    let unknown = value == (1u64 << (7 * len)) - 1;
    Some((if unknown { None } else { Some(value) }, len))
}

fn read_vint_value(data: &[u8]) -> Option<(u64, usize)> {
    match read_size(data)? {
        (Some(value), len) => Some((value, len)),
        (None, _) => None,
    }
}

fn read_uint(data: &[u8]) -> u64 {
    data.iter()
        .fold(0u64, |acc, &byte| (acc << 8) | u64::from(byte))
}

/// Iterates the children of an in-memory element body.
fn children(data: &[u8]) -> Vec<(u32, &[u8], &[u8])> {
    let mut out = Vec::new();
    let mut pos = 0usize;
    while pos < data.len() {
        let Some((id, id_len)) = read_id(&data[pos..]) else {
            break;
        };
        let Some((Some(size), size_len)) = read_size(&data[pos + id_len..]) else {
            break;
        };
        let body_start = pos + id_len + size_len;
        let Some(body_end) = body_start
            .checked_add(size as usize)
            .filter(|&end| end <= data.len())
        else {
            break;
        };
        out.push((id, &data[pos..body_end], &data[body_start..body_end]));
        pos = body_end;
    }
    out
}

fn encode_id(id: u32) -> Vec<u8> {
    let bytes = id.to_be_bytes();
    let skip = bytes.iter().take_while(|&&byte| byte == 0).count().min(3);
    bytes[skip..].to_vec()
}

fn encode_size(size: u64) -> Vec<u8> {
    let len = (1..=8)
        .find(|&len| size < (1u64 << (7 * len)) - 1)
        .unwrap_or(8);
    encode_size_fixed(size, len)
}

fn encode_size_fixed(size: u64, len: usize) -> Vec<u8> {
    let marked = size | (1u64 << (7 * len));
    marked.to_be_bytes()[8 - len..].to_vec()
}

fn element(id: u32, body: &[u8]) -> Vec<u8> {
    let mut out = encode_id(id);
    out.extend(encode_size(body.len() as u64));
    out.extend_from_slice(body);
    out
}

fn uint_element(id: u32, value: u64) -> Vec<u8> {
    let bytes = value.to_be_bytes();
    let skip = bytes.iter().take_while(|&&byte| byte == 0).count().min(7);
    element(id, &bytes[skip..])
}

fn fixed_uint_element(id: u32, value: u64) -> Vec<u8> {
    element(id, &value.to_be_bytes())
}

struct ClusterInfo {
    /// Source byte range of the cluster's children.
    body_start: u64,
    body_end: u64,
    timecode: u64,
    /// Earliest video keyframe (or first block) time, for the cue.
    cue: Option<(u64, u64)>,
}

#[derive(Default)]
struct Scan {
    info: Option<Vec<u8>>,
    tracks: Option<Vec<u8>>,
    other: Vec<Vec<u8>>,
    clusters: Vec<ClusterInfo>,
}

/// Returns true when the WebM at `path` lacks a duration or seek index.
pub fn needs_index(path: &Path) -> Result<bool> {
    let file = File::open(path).map_err(|error| error.to_string())?;
    let len = file.metadata().map_err(|error| error.to_string())?.len();
    let mut source = Source { file, len };
    let Some(segment) = find_segment(&mut source)? else {
        return Ok(false);
    };
    let mut pos = segment.data_start;
    let end = segment.size.map_or(len, |size| segment.data_start + size);
    let mut has_cues = false;
    let mut has_duration = false;
    while let Some(child) = source.element_at(pos)? {
        if child.start >= end {
            break;
        }
        match child.id {
            CUES => has_cues = true,
            INFO => {
                let size = child.size.unwrap_or(0);
                let body = source.read_range(
                    child.data_start,
                    child.data_start + size,
                    MAX_METADATA_BYTES,
                )?;
                has_duration = children(&body).iter().any(|(id, _, _)| *id == DURATION);
            }
            _ => {}
        }
        match child.size {
            Some(size) => pos = child.data_start + size,
            // Unknown sizes only come from live writers like MediaRecorder.
            None => return Ok(true),
        }
    }
    Ok(!(has_cues && has_duration))
}

fn find_segment(source: &mut Source) -> Result<Option<Element>> {
    let mut pos = 0u64;
    while let Some(element) = source.element_at(pos)? {
        if element.id == SEGMENT {
            return Ok(Some(element));
        }
        let Some(size) = element.size else {
            return Ok(None);
        };
        pos = element.data_start + size;
    }
    Ok(None)
}

/// Writes an indexed, seekable copy of the WebM at `input` to `output`.
pub fn rewrite_with_index(input: &Path, output: &Path) -> Result<()> {
    let file = File::open(input).map_err(|error| error.to_string())?;
    let len = file.metadata().map_err(|error| error.to_string())?.len();
    let mut source = Source { file, len };
    let segment =
        find_segment(&mut source)?.ok_or_else(|| String::from("recording has no WebM segment"))?;
    let ebml_header = source.read_range(0, segment.start, MAX_METADATA_BYTES)?;
    let segment_end = segment
        .size
        .map_or(len, |size| (segment.data_start + size).min(len));

    let mut scan = Scan::default();
    let mut video_track: Option<u64> = None;
    let mut pos = segment.data_start;
    while pos < segment_end {
        let Some(child) = source.element_at(pos)? else {
            break;
        };
        if child.id == CLUSTER {
            let body_end = match child.size {
                Some(size) => (child.data_start + size).min(segment_end),
                None => find_unknown_cluster_end(&mut source, child.data_start, segment_end)?,
            };
            let body = source.read_range(child.data_start, body_end, MAX_CLUSTER_BYTES)?;
            scan.clusters
                .push(scan_cluster(&body, child.data_start, body_end, video_track));
            pos = body_end;
            continue;
        }
        let Some(size) = child.size else {
            return Err(String::from("unexpected unknown-size WebM element"));
        };
        let end = child.data_start + size;
        if end > segment_end {
            break;
        }
        match child.id {
            INFO => {
                scan.info = Some(source.read_range(child.data_start, end, MAX_METADATA_BYTES)?)
            }
            TRACKS => {
                let body = source.read_range(child.data_start, end, MAX_METADATA_BYTES)?;
                video_track = find_video_track(&body);
                scan.tracks = Some(body);
            }
            // Rebuilt below.
            SEEK_HEAD | CUES | VOID => {}
            _ => scan
                .other
                .push(source.read_range(child.start, end, MAX_METADATA_BYTES)?),
        }
        pos = end;
    }

    let info = scan
        .info
        .ok_or_else(|| String::from("recording has no WebM Info"))?;
    let tracks = scan
        .tracks
        .ok_or_else(|| String::from("recording has no WebM Tracks"))?;
    if scan.clusters.is_empty() {
        return Err(String::from("recording has no media clusters"));
    }

    // Duration is stored in timecode units, so the timecode scale never matters.
    let duration = recording_duration(&mut source, &scan.clusters)?;

    let info_element = {
        let mut body = Vec::new();
        for (id, raw, _) in children(&info) {
            if id != DURATION {
                body.extend_from_slice(raw);
            }
        }
        body.extend(element(DURATION, &duration.to_be_bytes()));
        element(INFO, &body)
    };
    let tracks_element = element(TRACKS, &tracks);
    let other: Vec<u8> = scan.other.concat();

    // SeekHead positions use fixed 8-byte values so its size never changes.
    let seek_head_len = build_seek_head(0, 0, 0).len() as u64;
    let info_pos = seek_head_len;
    let tracks_pos = info_pos + info_element.len() as u64;
    let mut cursor = tracks_pos + tracks_element.len() as u64 + other.len() as u64;
    let mut cluster_positions = Vec::with_capacity(scan.clusters.len());
    for cluster in &scan.clusters {
        cluster_positions.push(cursor);
        cursor += cluster_header_len() + (cluster.body_end - cluster.body_start);
    }
    let cues_pos = cursor;
    let cues = build_cues(&scan.clusters, &cluster_positions, video_track.unwrap_or(1));
    let seek_head = build_seek_head(info_pos, tracks_pos, cues_pos);
    let segment_size = cues_pos + cues.len() as u64;

    let out_file = File::create(output).map_err(|error| error.to_string())?;
    let mut out = BufWriter::with_capacity(1 << 20, out_file);
    let io = |error: std::io::Error| error.to_string();
    out.write_all(&ebml_header).map_err(io)?;
    out.write_all(&encode_id(SEGMENT)).map_err(io)?;
    out.write_all(&encode_size_fixed(segment_size, 8))
        .map_err(io)?;
    out.write_all(&seek_head).map_err(io)?;
    out.write_all(&info_element).map_err(io)?;
    out.write_all(&tracks_element).map_err(io)?;
    out.write_all(&other).map_err(io)?;
    let mut buffer = vec![0u8; 1 << 20];
    for cluster in &scan.clusters {
        let body_len = cluster.body_end - cluster.body_start;
        out.write_all(&encode_id(CLUSTER)).map_err(io)?;
        out.write_all(&encode_size_fixed(body_len, 8)).map_err(io)?;
        let mut copied = 0u64;
        while copied < body_len {
            let step = (body_len - copied).min(buffer.len() as u64) as usize;
            source.read_at(cluster.body_start + copied, &mut buffer[..step])?;
            out.write_all(&buffer[..step]).map_err(io)?;
            copied += step as u64;
        }
    }
    out.write_all(&cues).map_err(io)?;
    let out_file = out.into_inner().map_err(|error| error.to_string())?;
    out_file.sync_all().map_err(io)?;
    Ok(())
}

fn cluster_header_len() -> u64 {
    (encode_id(CLUSTER).len() + 8) as u64
}

/// An unknown-size Cluster ends at the next Segment-level element.
fn find_unknown_cluster_end(source: &mut Source, start: u64, segment_end: u64) -> Result<u64> {
    let mut pos = start;
    while pos < segment_end {
        let Some(child) = source.element_at(pos)? else {
            break;
        };
        if is_segment_child(child.id) {
            break;
        }
        let Some(size) = child.size else {
            break;
        };
        let end = child.data_start + size;
        if end > segment_end {
            // The recording was cut mid-block; drop the partial block.
            break;
        }
        pos = end;
    }
    Ok(pos)
}

fn find_video_track(tracks: &[u8]) -> Option<u64> {
    children(tracks)
        .into_iter()
        .filter(|(id, _, _)| *id == TRACK_ENTRY)
        .find_map(|(_, _, entry)| {
            let fields = children(entry);
            let number = fields.iter().find(|(id, _, _)| *id == TRACK_NUMBER)?;
            let kind = fields.iter().find(|(id, _, _)| *id == TRACK_TYPE)?;
            (read_uint(kind.2) == TRACK_TYPE_VIDEO).then(|| read_uint(number.2))
        })
}

/// Parses a block header: (track number, relative timecode, keyframe flag).
fn block_header(block: &[u8], simple: bool) -> Option<(u64, i16, bool)> {
    let (track, len) = read_vint_value(block)?;
    let timecode = i16::from_be_bytes(block.get(len..len + 2)?.try_into().ok()?);
    let flags = *block.get(len + 2)?;
    Some((track, timecode, simple && flags & 0x80 != 0))
}

struct BlockTime {
    track: u64,
    time: u64,
    duration: Option<u64>,
}

fn cluster_blocks(body: &[u8]) -> (u64, Vec<(BlockTime, bool)>) {
    let mut timecode = 0u64;
    let mut blocks = Vec::new();
    for (id, _, data) in children(body) {
        match id {
            CLUSTER_TIMECODE => timecode = read_uint(data),
            SIMPLE_BLOCK => {
                if let Some((track, relative, keyframe)) = block_header(data, true) {
                    let time = timecode.saturating_add_signed(i64::from(relative));
                    blocks.push((
                        BlockTime {
                            track,
                            time,
                            duration: None,
                        },
                        keyframe,
                    ));
                }
            }
            BLOCK_GROUP => {
                let fields = children(data);
                let Some((_, _, block)) = fields.iter().find(|(id, _, _)| *id == BLOCK) else {
                    continue;
                };
                if let Some((track, relative, _)) = block_header(block, false) {
                    let keyframe = !fields.iter().any(|(id, _, _)| *id == REFERENCE_BLOCK);
                    let duration = fields
                        .iter()
                        .find(|(id, _, _)| *id == BLOCK_DURATION)
                        .map(|(_, _, value)| read_uint(value));
                    let time = timecode.saturating_add_signed(i64::from(relative));
                    blocks.push((
                        BlockTime {
                            track,
                            time,
                            duration,
                        },
                        keyframe,
                    ));
                }
            }
            _ => {}
        }
    }
    (timecode, blocks)
}

fn scan_cluster(
    body: &[u8],
    body_start: u64,
    body_end: u64,
    video_track: Option<u64>,
) -> ClusterInfo {
    let (timecode, blocks) = cluster_blocks(body);
    let cue = match video_track {
        Some(video) => blocks
            .iter()
            .filter(|(block, keyframe)| block.track == video && *keyframe)
            .map(|(block, _)| (block.time, video))
            .min(),
        None => blocks
            .iter()
            .map(|(block, _)| (block.time, block.track))
            .min(),
    };
    ClusterInfo {
        body_start,
        body_end,
        timecode,
        cue,
    }
}

/// Duration in timecode units: the last block's end time.
fn recording_duration(source: &mut Source, clusters: &[ClusterInfo]) -> Result<f64> {
    // The final cluster holds the latest blocks; earlier ones only matter for
    // estimating how long the last frame lasts.
    let last = clusters.last().expect("checked non-empty");
    let body = source.read_range(last.body_start, last.body_end, MAX_CLUSTER_BYTES)?;
    let (_, blocks) = cluster_blocks(&body);
    let Some(end) = blocks
        .iter()
        .map(|(block, _)| block.time + block.duration.unwrap_or(0))
        .max()
    else {
        return Ok(last.timecode as f64);
    };
    // Add one typical frame of the track that ends last, since a block's
    // timestamp marks its start.
    let last_track = blocks
        .iter()
        .max_by_key(|(block, _)| block.time)
        .map(|(block, _)| block.track);
    let mut track_times: Vec<u64> = blocks
        .iter()
        .filter(|(block, _)| Some(block.track) == last_track && block.duration.is_none())
        .map(|(block, _)| block.time)
        .collect();
    track_times.sort_unstable();
    let frame = track_times
        .windows(2)
        .map(|pair| pair[1] - pair[0])
        .filter(|&gap| gap > 0)
        .min()
        .unwrap_or(0);
    Ok((end + frame) as f64)
}

fn build_seek_head(info_pos: u64, tracks_pos: u64, cues_pos: u64) -> Vec<u8> {
    let mut body = Vec::new();
    for (id, position) in [(INFO, info_pos), (TRACKS, tracks_pos), (CUES, cues_pos)] {
        let mut seek = element(SEEK_ID, &encode_id(id));
        seek.extend(fixed_uint_element(SEEK_POSITION, position));
        body.extend(element(SEEK, &seek));
    }
    element(SEEK_HEAD, &body)
}

fn build_cues(clusters: &[ClusterInfo], positions: &[u64], fallback_track: u64) -> Vec<u8> {
    let mut body = Vec::new();
    let mut last_time = None;
    for (cluster, &position) in clusters.iter().zip(positions) {
        let Some((time, track)) = cluster.cue else {
            continue;
        };
        if last_time == Some(time) {
            continue;
        }
        last_time = Some(time);
        let mut track_positions =
            uint_element(CUE_TRACK, if track == 0 { fallback_track } else { track });
        track_positions.extend(uint_element(CUE_CLUSTER_POSITION, position));
        let mut point = uint_element(CUE_TIME, time);
        point.extend(element(CUE_TRACK_POSITIONS, &track_positions));
        body.extend(element(CUE_POINT, &point));
    }
    element(CUES, &body)
}

#[cfg(test)]
mod tests {
    use super::*;

    const UNKNOWN_SIZE: [u8; 8] = [0x01, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF];

    fn simple_block(track: u8, relative: i16, keyframe: bool, payload: &[u8]) -> Vec<u8> {
        let mut body = vec![0x80 | track];
        body.extend_from_slice(&relative.to_be_bytes());
        body.push(if keyframe { 0x80 } else { 0 });
        body.extend_from_slice(payload);
        element(SIMPLE_BLOCK, &body)
    }

    fn track_entry(number: u64, kind: u64) -> Vec<u8> {
        let mut body = uint_element(TRACK_NUMBER, number);
        body.extend(uint_element(TRACK_TYPE, kind));
        element(TRACK_ENTRY, &body)
    }

    fn live_webm() -> Vec<u8> {
        let mut file = element(EBML_HEADER, &uint_element(0x4282, 0));
        file.extend(encode_id(SEGMENT));
        file.extend(UNKNOWN_SIZE);
        file.extend(element(INFO, &uint_element(TIMECODE_SCALE, 1_000_000)));
        let mut tracks = track_entry(1, 2);
        tracks.extend(track_entry(2, 1));
        file.extend(element(TRACKS, &tracks));
        for (timecode, offset) in [(0u64, 0i16), (1000, 0)] {
            file.extend(encode_id(CLUSTER));
            file.extend(UNKNOWN_SIZE);
            file.extend(uint_element(CLUSTER_TIMECODE, timecode));
            file.extend(simple_block(1, offset, true, b"aa"));
            file.extend(simple_block(2, offset, true, b"KEY"));
            file.extend(simple_block(2, offset + 33, false, b"p1"));
            file.extend(simple_block(2, offset + 66, false, b"p2"));
        }
        file
    }

    fn temp_dir(name: &str) -> std::path::PathBuf {
        let dir =
            std::env::temp_dir().join(format!("mirrorsim-webm-{name}-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn find(data: &[u8], id: u32) -> &[u8] {
        children(data)
            .into_iter()
            .find(|(child, _, _)| *child == id)
            .map(|(_, _, body)| body)
            .unwrap_or_else(|| panic!("missing element {id:#x}"))
    }

    #[test]
    fn adds_duration_sizes_and_cues_to_live_webm() {
        let dir = temp_dir("rewrite");
        let input = dir.join("in.webm");
        let output = dir.join("out.webm");
        std::fs::write(&input, live_webm()).unwrap();

        assert!(needs_index(&input).unwrap());
        rewrite_with_index(&input, &output).unwrap();
        assert!(!needs_index(&output).unwrap());

        let data = std::fs::read(&output).unwrap();
        let segment = find(&data, SEGMENT);
        let info = find(segment, INFO);
        let duration = f64::from_be_bytes(find(info, DURATION).try_into().unwrap());
        // Last video frame starts at 1066 ms and lasts one 33 ms frame.
        assert_eq!(duration, 1099.0);

        let clusters: Vec<_> = children(segment)
            .into_iter()
            .filter(|(id, _, _)| *id == CLUSTER)
            .collect();
        assert_eq!(clusters.len(), 2);

        let cues = find(segment, CUES);
        let points: Vec<_> = children(cues)
            .into_iter()
            .map(|(_, _, body)| body)
            .collect();
        assert_eq!(points.len(), 2);
        assert_eq!(read_uint(find(points[1], CUE_TIME)), 1000);
        let positions = find(points[1], CUE_TRACK_POSITIONS);
        assert_eq!(read_uint(find(positions, CUE_TRACK)), 2);
        // Cue positions are relative to the segment body and land on a cluster.
        let cluster_pos = read_uint(find(positions, CUE_CLUSTER_POSITION)) as usize;
        assert_eq!(read_id(&segment[cluster_pos..]).unwrap().0, CLUSTER);

        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn size_vints_round_trip() {
        for value in [0u64, 1, 126, 127, 16_382, 16_383, 1 << 40] {
            let encoded = encode_size(value);
            assert_eq!(read_size(&encoded), Some((Some(value), encoded.len())));
        }
        assert_eq!(read_size(&UNKNOWN_SIZE), Some((None, 8)));
    }
}
