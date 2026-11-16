//! Rewrites the fragmented MP4 that MediaRecorder streams out into a regular
//! MP4 with a complete sample index at the front of the file.
//!
//! Fragmented files play, but their `moov` box carries no duration and no
//! sample tables, so many desktop players (Windows Media Player, Photos,
//! some editors) show no timeline and cannot seek. Rewriting copies the
//! encoded samples unchanged; nothing is re-encoded.

use std::fs::File;
use std::io::{self, BufWriter, Read, Seek, SeekFrom, Write};
use std::path::Path;

const COPY_BUFFER_BYTES: usize = 1 << 20;

// tfhd flags
const TFHD_BASE_DATA_OFFSET: u32 = 0x00_0001;
const TFHD_SAMPLE_DESCRIPTION_INDEX: u32 = 0x00_0002;
const TFHD_DEFAULT_DURATION: u32 = 0x00_0008;
const TFHD_DEFAULT_SIZE: u32 = 0x00_0010;
const TFHD_DEFAULT_FLAGS: u32 = 0x00_0020;
const TFHD_DEFAULT_BASE_IS_MOOF: u32 = 0x02_0000;

// trun flags
const TRUN_DATA_OFFSET: u32 = 0x00_0001;
const TRUN_FIRST_SAMPLE_FLAGS: u32 = 0x00_0004;
const TRUN_SAMPLE_DURATION: u32 = 0x00_0100;
const TRUN_SAMPLE_SIZE: u32 = 0x00_0200;
const TRUN_SAMPLE_FLAGS: u32 = 0x00_0400;
const TRUN_SAMPLE_CTO: u32 = 0x00_0800;

const SAMPLE_IS_NON_SYNC: u32 = 0x0001_0000;

type Result<T> = std::result::Result<T, String>;

#[derive(Clone, Copy, Debug)]
struct BoxHeader {
    kind: [u8; 4],
    /// Offset of the box's first byte in its parent buffer or file.
    start: u64,
    header_len: u64,
    size: u64,
}

impl BoxHeader {
    fn payload_start(&self) -> u64 {
        self.start + self.header_len
    }

    fn end(&self) -> u64 {
        self.start + self.size
    }
}

/// Lists the boxes in `data[start..end]`.
fn boxes_in(data: &[u8], start: usize, end: usize) -> Result<Vec<BoxHeader>> {
    let mut boxes = Vec::new();
    let mut pos = start;
    while pos + 8 <= end {
        let size32 = read_u32(data, pos)?;
        let kind: [u8; 4] = data[pos + 4..pos + 8].try_into().expect("4 bytes");
        let (size, header_len) = match size32 {
            0 => ((end - pos) as u64, 8),
            1 => (read_u64(data, pos + 8)?, 16),
            value => (u64::from(value), 8),
        };
        if size < header_len || pos as u64 + size > end as u64 {
            return Err(format!("box '{}' overruns its parent", fourcc(&kind)));
        }
        boxes.push(BoxHeader {
            kind,
            start: pos as u64,
            header_len,
            size,
        });
        pos += size as usize;
    }
    Ok(boxes)
}

fn children(data: &[u8], parent: &BoxHeader) -> Result<Vec<BoxHeader>> {
    boxes_in(data, parent.payload_start() as usize, parent.end() as usize)
}

fn child<'a>(boxes: &'a [BoxHeader], kind: &[u8; 4]) -> Option<&'a BoxHeader> {
    boxes.iter().find(|value| &value.kind == kind)
}

fn payload<'a>(data: &'a [u8], header: &BoxHeader) -> &'a [u8] {
    &data[header.payload_start() as usize..header.end() as usize]
}

fn raw<'a>(data: &'a [u8], header: &BoxHeader) -> &'a [u8] {
    &data[header.start as usize..header.end() as usize]
}

fn fourcc(kind: &[u8; 4]) -> String {
    String::from_utf8_lossy(kind).into_owned()
}

fn read_u32(data: &[u8], pos: usize) -> Result<u32> {
    data.get(pos..pos + 4)
        .map(|bytes| u32::from_be_bytes(bytes.try_into().expect("4 bytes")))
        .ok_or_else(|| String::from("MP4 box is truncated"))
}

fn read_u64(data: &[u8], pos: usize) -> Result<u64> {
    data.get(pos..pos + 8)
        .map(|bytes| u64::from_be_bytes(bytes.try_into().expect("8 bytes")))
        .ok_or_else(|| String::from("MP4 box is truncated"))
}

/// Reads sequential big-endian fields from a box payload.
struct Cursor<'a> {
    data: &'a [u8],
    pos: usize,
}

impl<'a> Cursor<'a> {
    fn new(data: &'a [u8]) -> Self {
        Self { data, pos: 0 }
    }

    fn u32(&mut self) -> Result<u32> {
        let value = read_u32(self.data, self.pos)?;
        self.pos += 4;
        Ok(value)
    }

    fn u64(&mut self) -> Result<u64> {
        let value = read_u64(self.data, self.pos)?;
        self.pos += 8;
        Ok(value)
    }

    /// Returns (version, flags) from a full box header.
    fn full_header(&mut self) -> Result<(u8, u32)> {
        let value = self.u32()?;
        Ok(((value >> 24) as u8, value & 0x00FF_FFFF))
    }
}

#[derive(Clone, Copy, Default)]
struct SampleDefaults {
    duration: u32,
    size: u32,
    flags: u32,
}

struct TrackSamples {
    track_id: u32,
    /// Decode time of the first sample, in media timescale.
    first_decode_time: Option<u64>,
    durations: Vec<u32>,
    /// Sum of `durations`, kept for fragment alignment.
    durations_sum: u64,
    sizes: Vec<u32>,
    composition_offsets: Vec<i32>,
    sync: Vec<bool>,
    /// (source offset, sample count) of each contiguous run of samples.
    chunks: Vec<(u64, u32)>,
}

impl TrackSamples {
    fn new(track_id: u32) -> Self {
        Self {
            track_id,
            first_decode_time: None,
            durations: Vec::new(),
            durations_sum: 0,
            sizes: Vec::new(),
            composition_offsets: Vec::new(),
            sync: Vec::new(),
            chunks: Vec::new(),
        }
    }

    /// Applies a fragment's decode time. MediaRecorder leaves small gaps
    /// between fragments; folding them into the previous sample's duration
    /// keeps every sample at its original timestamp, so audio stays in sync.
    fn align_to(&mut self, decode_time: u64) {
        let Some(first) = self.first_decode_time else {
            self.first_decode_time = Some(decode_time);
            return;
        };
        let Some(last) = self.durations.last_mut() else {
            return;
        };
        let expected = first + self.durations_sum;
        let corrected = i128::from(*last) + i128::from(decode_time) - i128::from(expected);
        let corrected = corrected.clamp(0, i128::from(u32::MAX)) as u32;
        self.durations_sum = self.durations_sum - u64::from(*last) + u64::from(corrected);
        *last = corrected;
    }

    fn push_duration(&mut self, duration: u32) {
        self.durations.push(duration);
        self.durations_sum += u64::from(duration);
    }

    fn media_duration(&self) -> u64 {
        self.durations.iter().map(|&value| u64::from(value)).sum()
    }
}

/// A chunk scheduled for the output `mdat`, in source order.
struct OutputChunk {
    track_index: usize,
    chunk_index: usize,
    source_offset: u64,
    length: u64,
}

/// Returns true when `path` is a fragmented MP4 that should be rewritten.
pub fn is_fragmented(path: &Path) -> Result<bool> {
    let mut file = File::open(path).map_err(|error| error.to_string())?;
    let file_len = file.metadata().map_err(|error| error.to_string())?.len();
    for header in top_level_boxes(&mut file, file_len)? {
        if &header.kind == b"moof" {
            return Ok(true);
        }
        if &header.kind == b"moov" {
            let moov = read_box(&mut file, &header)?;
            let boxes = boxes_in(&moov, header.header_len as usize, moov.len())?;
            if child(&boxes, b"mvex").is_some() {
                return Ok(true);
            }
        }
    }
    Ok(false)
}

/// Writes a seekable, non-fragmented copy of the fragmented MP4 at `input`
/// to `output`.
pub fn rewrite_fragmented(input: &Path, output: &Path) -> Result<()> {
    let mut source = File::open(input).map_err(|error| error.to_string())?;
    let file_len = source.metadata().map_err(|error| error.to_string())?.len();
    let top = top_level_boxes(&mut source, file_len)?;

    let moov_header = *top
        .iter()
        .find(|value| &value.kind == b"moov")
        .ok_or_else(|| String::from("recording has no moov box"))?;
    let moov = read_box(&mut source, &moov_header)?;
    let moov_children = boxes_in(&moov, moov_header.header_len as usize, moov.len())?;

    let traks: Vec<BoxHeader> = moov_children
        .iter()
        .filter(|value| &value.kind == b"trak")
        .copied()
        .collect();
    if traks.is_empty() {
        return Err(String::from("recording has no tracks"));
    }
    let mut tracks = Vec::with_capacity(traks.len());
    for trak in &traks {
        tracks.push(TrackSamples::new(trak_track_id(&moov, trak)?));
    }
    let trex_defaults = read_trex_defaults(&moov, &moov_children)?;

    for header in top.iter().filter(|value| &value.kind == b"moof") {
        let moof = read_box(&mut source, header)?;
        collect_fragment(&moof, header.start, &trex_defaults, &mut tracks)?;
    }

    let mut chunks = Vec::new();
    for (track_index, track) in tracks.iter().enumerate() {
        let mut sample = 0usize;
        for (chunk_index, &(source_offset, count)) in track.chunks.iter().enumerate() {
            let length = track.sizes[sample..sample + count as usize]
                .iter()
                .map(|&value| u64::from(value))
                .sum();
            sample += count as usize;
            chunks.push(OutputChunk {
                track_index,
                chunk_index,
                source_offset,
                length,
            });
        }
    }
    // Keep the encoder's audio/video interleaving.
    chunks.sort_by_key(|value| value.source_offset);
    for chunk in &chunks {
        if chunk.source_offset + chunk.length > file_len {
            return Err(String::from("recording sample data is truncated"));
        }
    }

    let media_bytes: u64 = chunks.iter().map(|value| value.length).sum();
    let ftyp = build_ftyp();
    let large_mdat = media_bytes + 8 > u64::from(u32::MAX);
    let mdat_header_len: u64 = if large_mdat { 16 } else { 8 };

    // Offsets do not change the moov size, so lay out with zeros first.
    let placeholder = vec![Vec::new(); tracks.len()];
    let use_co64 = ftyp.len() as u64
        + build_moov(&moov, &moov_children, &traks, &tracks, &placeholder, true)?.len() as u64
        + mdat_header_len
        + media_bytes
        > u64::from(u32::MAX);
    let moov_len = build_moov(
        &moov,
        &moov_children,
        &traks,
        &tracks,
        &placeholder,
        use_co64,
    )?
    .len() as u64;

    let mut chunk_offsets: Vec<Vec<u64>> = tracks
        .iter()
        .map(|value| vec![0; value.chunks.len()])
        .collect();
    let mut cursor = ftyp.len() as u64 + moov_len + mdat_header_len;
    for chunk in &chunks {
        chunk_offsets[chunk.track_index][chunk.chunk_index] = cursor;
        cursor += chunk.length;
    }
    let new_moov = build_moov(
        &moov,
        &moov_children,
        &traks,
        &tracks,
        &chunk_offsets,
        use_co64,
    )?;
    debug_assert_eq!(new_moov.len() as u64, moov_len);

    let out_file = File::create(output).map_err(|error| error.to_string())?;
    let mut out = BufWriter::with_capacity(COPY_BUFFER_BYTES, out_file);
    let write_error = |error: io::Error| error.to_string();
    out.write_all(&ftyp).map_err(write_error)?;
    out.write_all(&new_moov).map_err(write_error)?;
    if large_mdat {
        out.write_all(&1u32.to_be_bytes()).map_err(write_error)?;
        out.write_all(b"mdat").map_err(write_error)?;
        out.write_all(&(media_bytes + 16).to_be_bytes())
            .map_err(write_error)?;
    } else {
        out.write_all(&((media_bytes + 8) as u32).to_be_bytes())
            .map_err(write_error)?;
        out.write_all(b"mdat").map_err(write_error)?;
    }

    let mut buffer = vec![0u8; COPY_BUFFER_BYTES];
    for chunk in &chunks {
        source
            .seek(SeekFrom::Start(chunk.source_offset))
            .map_err(write_error)?;
        let mut remaining = chunk.length;
        while remaining > 0 {
            let step = remaining.min(buffer.len() as u64) as usize;
            source
                .read_exact(&mut buffer[..step])
                .map_err(write_error)?;
            out.write_all(&buffer[..step]).map_err(write_error)?;
            remaining -= step as u64;
        }
    }
    let out_file = out.into_inner().map_err(|error| error.to_string())?;
    out_file.sync_all().map_err(write_error)?;
    Ok(())
}

fn top_level_boxes(file: &mut File, file_len: u64) -> Result<Vec<BoxHeader>> {
    let mut boxes = Vec::new();
    let mut pos = 0u64;
    while pos + 8 <= file_len {
        file.seek(SeekFrom::Start(pos))
            .map_err(|error| error.to_string())?;
        let mut header = [0u8; 16];
        let available = (file_len - pos).min(16) as usize;
        file.read_exact(&mut header[..available])
            .map_err(|error| error.to_string())?;
        let size32 = u32::from_be_bytes(header[0..4].try_into().expect("4 bytes"));
        let kind: [u8; 4] = header[4..8].try_into().expect("4 bytes");
        let (size, header_len) = match size32 {
            0 => (file_len - pos, 8),
            1 if available == 16 => (
                u64::from_be_bytes(header[8..16].try_into().expect("8 bytes")),
                16,
            ),
            1 => return Err(String::from("MP4 box header is truncated")),
            value => (u64::from(value), 8),
        };
        if size < header_len {
            return Err(format!("box '{}' has an invalid size", fourcc(&kind)));
        }
        if pos + size > file_len {
            // A recording cut off mid-box keeps everything before it.
            break;
        }
        boxes.push(BoxHeader {
            kind,
            start: pos,
            header_len,
            size,
        });
        pos += size;
    }
    Ok(boxes)
}

/// Reads a whole box, header included. Only used for metadata boxes.
fn read_box(file: &mut File, header: &BoxHeader) -> Result<Vec<u8>> {
    const MAX_METADATA_BOX_BYTES: u64 = 256 << 20;
    if header.size > MAX_METADATA_BOX_BYTES {
        return Err(format!(
            "'{}' box is unexpectedly large",
            fourcc(&header.kind)
        ));
    }
    file.seek(SeekFrom::Start(header.start))
        .map_err(|error| error.to_string())?;
    let mut data = vec![0u8; header.size as usize];
    file.read_exact(&mut data)
        .map_err(|error| error.to_string())?;
    Ok(data)
}

fn trak_track_id(moov: &[u8], trak: &BoxHeader) -> Result<u32> {
    let trak_children = children(moov, trak)?;
    let tkhd = child(&trak_children, b"tkhd").ok_or_else(|| String::from("track has no tkhd"))?;
    let mut cursor = Cursor::new(payload(moov, tkhd));
    let (version, _) = cursor.full_header()?;
    if version == 1 {
        cursor.u64()?;
        cursor.u64()?;
    } else {
        cursor.u32()?;
        cursor.u32()?;
    }
    cursor.u32()
}

fn read_trex_defaults(
    moov: &[u8],
    moov_children: &[BoxHeader],
) -> Result<Vec<(u32, SampleDefaults)>> {
    let mut defaults = Vec::new();
    if let Some(mvex) = child(moov_children, b"mvex") {
        for trex in children(moov, mvex)?
            .iter()
            .filter(|value| &value.kind == b"trex")
        {
            let mut cursor = Cursor::new(payload(moov, trex));
            cursor.full_header()?;
            let track_id = cursor.u32()?;
            cursor.u32()?; // default_sample_description_index
            defaults.push((
                track_id,
                SampleDefaults {
                    duration: cursor.u32()?,
                    size: cursor.u32()?,
                    flags: cursor.u32()?,
                },
            ));
        }
    }
    Ok(defaults)
}

fn collect_fragment(
    moof: &[u8],
    moof_offset: u64,
    trex_defaults: &[(u32, SampleDefaults)],
    tracks: &mut [TrackSamples],
) -> Result<()> {
    let moof_header = boxes_in(moof, 0, moof.len())?
        .into_iter()
        .next()
        .ok_or_else(|| String::from("empty moof"))?;
    // Without explicit offsets, each traf's data follows the previous one's.
    let mut previous_traf_data_end = moof_offset;
    for traf in children(moof, &moof_header)?
        .iter()
        .filter(|value| &value.kind == b"traf")
    {
        let traf_children = children(moof, traf)?;
        let tfhd =
            child(&traf_children, b"tfhd").ok_or_else(|| String::from("traf has no tfhd"))?;
        let mut cursor = Cursor::new(payload(moof, tfhd));
        let (_, tfhd_flags) = cursor.full_header()?;
        let track_id = cursor.u32()?;
        let base_data_offset = if tfhd_flags & TFHD_BASE_DATA_OFFSET != 0 {
            cursor.u64()?
        } else if tfhd_flags & TFHD_DEFAULT_BASE_IS_MOOF != 0 {
            moof_offset
        } else {
            previous_traf_data_end
        };
        if tfhd_flags & TFHD_SAMPLE_DESCRIPTION_INDEX != 0 {
            cursor.u32()?;
        }
        let mut defaults = trex_defaults
            .iter()
            .find(|(id, _)| *id == track_id)
            .map(|(_, value)| *value)
            .unwrap_or_default();
        if tfhd_flags & TFHD_DEFAULT_DURATION != 0 {
            defaults.duration = cursor.u32()?;
        }
        if tfhd_flags & TFHD_DEFAULT_SIZE != 0 {
            defaults.size = cursor.u32()?;
        }
        if tfhd_flags & TFHD_DEFAULT_FLAGS != 0 {
            defaults.flags = cursor.u32()?;
        }

        let track = tracks
            .iter_mut()
            .find(|value| value.track_id == track_id)
            .ok_or_else(|| format!("fragment refers to unknown track {track_id}"))?;

        if let Some(tfdt) = child(&traf_children, b"tfdt") {
            let mut cursor = Cursor::new(payload(moof, tfdt));
            let (version, _) = cursor.full_header()?;
            let decode_time = if version == 1 {
                cursor.u64()?
            } else {
                u64::from(cursor.u32()?)
            };
            track.align_to(decode_time);
        }

        let mut data_cursor = base_data_offset;
        for trun in traf_children.iter().filter(|value| &value.kind == b"trun") {
            let mut cursor = Cursor::new(payload(moof, trun));
            let (version, flags) = cursor.full_header()?;
            let sample_count = cursor.u32()?;
            if flags & TRUN_DATA_OFFSET != 0 {
                let offset = cursor.u32()? as i32;
                data_cursor = base_data_offset
                    .checked_add_signed(i64::from(offset))
                    .ok_or_else(|| String::from("trun data offset is out of range"))?;
            }
            let first_sample_flags = if flags & TRUN_FIRST_SAMPLE_FLAGS != 0 {
                Some(cursor.u32()?)
            } else {
                None
            };
            let run_start = data_cursor;
            for index in 0..sample_count {
                let duration = if flags & TRUN_SAMPLE_DURATION != 0 {
                    cursor.u32()?
                } else {
                    defaults.duration
                };
                let size = if flags & TRUN_SAMPLE_SIZE != 0 {
                    cursor.u32()?
                } else {
                    defaults.size
                };
                let sample_flags = if flags & TRUN_SAMPLE_FLAGS != 0 {
                    cursor.u32()?
                } else if index == 0 {
                    first_sample_flags.unwrap_or(defaults.flags)
                } else {
                    defaults.flags
                };
                let composition_offset = if flags & TRUN_SAMPLE_CTO != 0 {
                    let value = cursor.u32()?;
                    if version == 0 {
                        value.min(i32::MAX as u32) as i32
                    } else {
                        value as i32
                    }
                } else {
                    0
                };
                track.push_duration(duration);
                track.sizes.push(size);
                track.composition_offsets.push(composition_offset);
                track.sync.push(sample_flags & SAMPLE_IS_NON_SYNC == 0);
                data_cursor += u64::from(size);
            }
            if sample_count > 0 {
                track.chunks.push((run_start, sample_count));
            }
        }
        previous_traf_data_end = data_cursor;
    }
    Ok(())
}

fn build_ftyp() -> Vec<u8> {
    let mut body = Vec::new();
    body.extend_from_slice(b"isom");
    body.extend_from_slice(&0x200u32.to_be_bytes());
    for brand in [b"isom", b"iso2", b"avc1", b"mp41"] {
        body.extend_from_slice(brand);
    }
    make_box(b"ftyp", &body)
}

fn make_box(kind: &[u8; 4], body: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(body.len() + 8);
    out.extend_from_slice(&((body.len() + 8) as u32).to_be_bytes());
    out.extend_from_slice(kind);
    out.extend_from_slice(body);
    out
}

fn make_full_box(kind: &[u8; 4], version: u8, flags: u32, body: &[u8]) -> Vec<u8> {
    let mut full = Vec::with_capacity(body.len() + 4);
    full.extend_from_slice(&((u32::from(version) << 24) | (flags & 0x00FF_FFFF)).to_be_bytes());
    full.extend_from_slice(body);
    make_box(kind, &full)
}

/// Reads the timescale of an mvhd or mdhd payload.
fn header_timescale(payload: &[u8]) -> Result<u32> {
    let mut cursor = Cursor::new(payload);
    let (version, _) = cursor.full_header()?;
    if version == 1 {
        cursor.u64()?;
        cursor.u64()?;
    } else {
        cursor.u32()?;
        cursor.u32()?;
    }
    cursor.u32()
}

/// Returns a copy of an mvhd/mdhd/tkhd box with its duration replaced.
/// `duration_offset_v0` / `_v1` are the field's offsets within the payload.
fn with_duration(
    raw_box: &[u8],
    header_len: usize,
    duration: u64,
    duration_offset_v0: usize,
    duration_offset_v1: usize,
) -> Vec<u8> {
    let mut out = raw_box.to_vec();
    let version = out[header_len];
    if version == 1 {
        let at = header_len + duration_offset_v1;
        out[at..at + 8].copy_from_slice(&duration.to_be_bytes());
    } else {
        let at = header_len + duration_offset_v0;
        let value = u32::try_from(duration).unwrap_or(u32::MAX);
        out[at..at + 4].copy_from_slice(&value.to_be_bytes());
    }
    out
}

fn scale(value: u64, from: u32, to: u32) -> u64 {
    if from == 0 {
        return 0;
    }
    (u128::from(value) * u128::from(to) / u128::from(from)) as u64
}

fn build_moov(
    moov: &[u8],
    moov_children: &[BoxHeader],
    traks: &[BoxHeader],
    tracks: &[TrackSamples],
    chunk_offsets: &[Vec<u64>],
    use_co64: bool,
) -> Result<Vec<u8>> {
    let mvhd =
        child(moov_children, b"mvhd").ok_or_else(|| String::from("recording has no mvhd"))?;
    let movie_timescale = header_timescale(payload(moov, mvhd))?;

    let mut built_traks = Vec::new();
    let mut movie_duration = 0u64;
    for (index, trak) in traks.iter().enumerate() {
        let offsets = chunk_offsets.get(index).map(Vec::as_slice).unwrap_or(&[]);
        let (bytes, track_duration) = build_trak(
            moov,
            trak,
            &tracks[index],
            offsets,
            movie_timescale,
            use_co64,
        )?;
        movie_duration = movie_duration.max(track_duration);
        built_traks.push(bytes);
    }

    let mut body = Vec::new();
    let mut traks_written = false;
    for box_header in moov_children {
        match &box_header.kind {
            b"mvhd" => body.extend(with_duration(
                raw(moov, box_header),
                box_header.header_len as usize,
                movie_duration,
                16,
                24,
            )),
            b"mvex" => {}
            b"trak" => {
                if !traks_written {
                    for trak in &built_traks {
                        body.extend_from_slice(trak);
                    }
                    traks_written = true;
                }
            }
            _ => body.extend_from_slice(raw(moov, box_header)),
        }
    }
    Ok(make_box(b"moov", &body))
}

/// Builds one track and returns it with its duration in movie timescale.
fn build_trak(
    moov: &[u8],
    trak: &BoxHeader,
    samples: &TrackSamples,
    chunk_offsets: &[u64],
    movie_timescale: u32,
    use_co64: bool,
) -> Result<(Vec<u8>, u64)> {
    let trak_children = children(moov, trak)?;
    let mdia = child(&trak_children, b"mdia").ok_or_else(|| String::from("track has no mdia"))?;
    let mdia_children = children(moov, mdia)?;
    let mdhd = child(&mdia_children, b"mdhd").ok_or_else(|| String::from("track has no mdhd"))?;
    let media_timescale = header_timescale(payload(moov, mdhd))?;

    let media_duration = samples.media_duration();
    let lead_in = scale(
        samples.first_decode_time.unwrap_or(0),
        media_timescale,
        movie_timescale,
    );
    let presented = scale(media_duration, media_timescale, movie_timescale);
    let track_duration = lead_in + presented;

    let mut body = Vec::new();
    for box_header in &trak_children {
        match &box_header.kind {
            b"tkhd" => {
                body.extend(with_duration(
                    raw(moov, box_header),
                    box_header.header_len as usize,
                    track_duration,
                    20,
                    28,
                ));
                if lead_in > 0 {
                    body.extend(build_edit_list(lead_in, presented));
                }
            }
            // Replaced above when needed; an old edit list would be stale.
            b"edts" => {}
            b"mdia" => {
                let mut mdia_body = Vec::new();
                for mdia_child in &mdia_children {
                    match &mdia_child.kind {
                        b"mdhd" => mdia_body.extend(with_duration(
                            raw(moov, mdia_child),
                            mdia_child.header_len as usize,
                            media_duration,
                            16,
                            24,
                        )),
                        b"minf" => mdia_body.extend(build_minf(
                            moov,
                            mdia_child,
                            samples,
                            chunk_offsets,
                            use_co64,
                        )?),
                        _ => mdia_body.extend_from_slice(raw(moov, mdia_child)),
                    }
                }
                body.extend(make_box(b"mdia", &mdia_body));
            }
            _ => body.extend_from_slice(raw(moov, box_header)),
        }
    }
    Ok((make_box(b"trak", &body), track_duration))
}

fn build_edit_list(lead_in: u64, presented: u64) -> Vec<u8> {
    let mut elst = Vec::new();
    elst.extend_from_slice(&2u32.to_be_bytes());
    // An empty edit delays the track; then the whole media plays at 1x.
    elst.extend_from_slice(&lead_in.to_be_bytes());
    elst.extend_from_slice(&(-1i64).to_be_bytes());
    elst.extend_from_slice(&0x0001_0000u32.to_be_bytes());
    elst.extend_from_slice(&presented.to_be_bytes());
    elst.extend_from_slice(&0i64.to_be_bytes());
    elst.extend_from_slice(&0x0001_0000u32.to_be_bytes());
    make_box(b"edts", &make_full_box(b"elst", 1, 0, &elst))
}

fn build_minf(
    moov: &[u8],
    minf: &BoxHeader,
    samples: &TrackSamples,
    chunk_offsets: &[u64],
    use_co64: bool,
) -> Result<Vec<u8>> {
    let mut body = Vec::new();
    for minf_child in children(moov, minf)? {
        if &minf_child.kind == b"stbl" {
            let stbl_children = children(moov, &minf_child)?;
            let stsd =
                child(&stbl_children, b"stsd").ok_or_else(|| String::from("track has no stsd"))?;
            body.extend(build_stbl(
                raw(moov, stsd),
                samples,
                chunk_offsets,
                use_co64,
            ));
        } else {
            body.extend_from_slice(raw(moov, &minf_child));
        }
    }
    Ok(make_box(b"minf", &body))
}

fn run_lengths<T: Copy + PartialEq>(values: impl IntoIterator<Item = T>) -> Vec<(u32, T)> {
    let mut runs: Vec<(u32, T)> = Vec::new();
    for value in values {
        match runs.last_mut() {
            Some((count, last)) if *last == value => *count += 1,
            _ => runs.push((1, value)),
        }
    }
    runs
}

fn build_stbl(
    stsd: &[u8],
    samples: &TrackSamples,
    chunk_offsets: &[u64],
    use_co64: bool,
) -> Vec<u8> {
    let mut body = stsd.to_vec();

    let stts_runs = run_lengths(samples.durations.iter().copied());
    let mut stts = (stts_runs.len() as u32).to_be_bytes().to_vec();
    for (count, delta) in stts_runs {
        stts.extend_from_slice(&count.to_be_bytes());
        stts.extend_from_slice(&delta.to_be_bytes());
    }
    body.extend(make_full_box(b"stts", 0, 0, &stts));

    if samples.composition_offsets.iter().any(|&value| value != 0) {
        let negative = samples.composition_offsets.iter().any(|&value| value < 0);
        let runs = run_lengths(samples.composition_offsets.iter().copied());
        let mut ctts = (runs.len() as u32).to_be_bytes().to_vec();
        for (count, offset) in runs {
            ctts.extend_from_slice(&count.to_be_bytes());
            ctts.extend_from_slice(&offset.to_be_bytes());
        }
        body.extend(make_full_box(b"ctts", u8::from(negative), 0, &ctts));
    }

    if samples.sync.iter().any(|&value| !value) {
        let sync_samples: Vec<u32> = samples
            .sync
            .iter()
            .enumerate()
            .filter(|(_, &is_sync)| is_sync)
            .map(|(index, _)| index as u32 + 1)
            .collect();
        let mut stss = (sync_samples.len() as u32).to_be_bytes().to_vec();
        for number in sync_samples {
            stss.extend_from_slice(&number.to_be_bytes());
        }
        body.extend(make_full_box(b"stss", 0, 0, &stss));
    }

    let mut stsc_entries: Vec<(u32, u32)> = Vec::new();
    for (index, &(_, count)) in samples.chunks.iter().enumerate() {
        if stsc_entries.last().map(|&(_, last)| last) != Some(count) {
            stsc_entries.push((index as u32 + 1, count));
        }
    }
    let mut stsc = (stsc_entries.len() as u32).to_be_bytes().to_vec();
    for (first_chunk, count) in stsc_entries {
        stsc.extend_from_slice(&first_chunk.to_be_bytes());
        stsc.extend_from_slice(&count.to_be_bytes());
        stsc.extend_from_slice(&1u32.to_be_bytes());
    }
    body.extend(make_full_box(b"stsc", 0, 0, &stsc));

    let uniform_size = match samples.sizes.first() {
        Some(&first) if samples.sizes.iter().all(|&value| value == first) => first,
        _ => 0,
    };
    let mut stsz = uniform_size.to_be_bytes().to_vec();
    stsz.extend_from_slice(&(samples.sizes.len() as u32).to_be_bytes());
    if uniform_size == 0 {
        for &size in &samples.sizes {
            stsz.extend_from_slice(&size.to_be_bytes());
        }
    }
    body.extend(make_full_box(b"stsz", 0, 0, &stsz));

    let mut offsets = (samples.chunks.len() as u32).to_be_bytes().to_vec();
    for index in 0..samples.chunks.len() {
        let offset = chunk_offsets.get(index).copied().unwrap_or(0);
        if use_co64 {
            offsets.extend_from_slice(&offset.to_be_bytes());
        } else {
            offsets.extend_from_slice(&(offset as u32).to_be_bytes());
        }
    }
    body.extend(make_full_box(
        if use_co64 { b"co64" } else { b"stco" },
        0,
        0,
        &offsets,
    ));

    make_box(b"stbl", &body)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn full(kind: &[u8; 4], version: u8, flags: u32, body: &[u8]) -> Vec<u8> {
        make_full_box(kind, version, flags, body)
    }

    fn tkhd(track_id: u32) -> Vec<u8> {
        let mut body = vec![0u8; 80];
        body[8..12].copy_from_slice(&track_id.to_be_bytes());
        full(b"tkhd", 0, 3, &body)
    }

    fn media_header(kind: &[u8; 4], timescale: u32) -> Vec<u8> {
        let mut body = vec![0u8; if kind == b"mvhd" { 96 } else { 20 }];
        body[8..12].copy_from_slice(&timescale.to_be_bytes());
        full(kind, 0, 0, &body)
    }

    fn empty_stbl() -> Vec<u8> {
        let stsd = full(
            b"stsd",
            0,
            0,
            &[
                0, 0, 0, 1, 0, 0, 0, 16, b't', b'e', b's', b't', 0, 0, 0, 0, 0, 0, 0, 1,
            ],
        );
        let mut body = stsd;
        for kind in [b"stts", b"stsc", b"stco"] {
            body.extend(full(kind, 0, 0, &0u32.to_be_bytes()));
        }
        body.extend(full(b"stsz", 0, 0, &[0; 8]));
        make_box(b"stbl", &body)
    }

    fn trak(track_id: u32, timescale: u32) -> Vec<u8> {
        let minf = make_box(b"minf", &empty_stbl());
        let mut mdia = media_header(b"mdhd", timescale);
        mdia.extend(full(b"hdlr", 0, 0, &[0; 21]));
        mdia.extend(minf);
        let mut body = tkhd(track_id);
        body.extend(make_box(b"mdia", &mdia));
        make_box(b"trak", &body)
    }

    fn trex(track_id: u32) -> Vec<u8> {
        let mut body = track_id.to_be_bytes().to_vec();
        body.extend_from_slice(&1u32.to_be_bytes());
        body.extend_from_slice(&[0; 12]);
        full(b"trex", 0, 0, &body)
    }

    /// (track id, decode time, [(duration, size, is sync)])
    type FragmentTrack<'a> = (u32, u64, &'a [(u32, u32, bool)]);

    /// One fragment: traf per track with explicit per-sample durations/sizes.
    fn fragment(sequence: u32, tracks: &[FragmentTrack], payloads: &[Vec<u8>]) -> Vec<u8> {
        let build = |data_offsets: &[u32]| {
            let mut moof = full(b"mfhd", 0, 0, &sequence.to_be_bytes());
            for (index, (track_id, decode_time, samples)) in tracks.iter().enumerate() {
                let mut traf = full(
                    b"tfhd",
                    0,
                    TFHD_DEFAULT_BASE_IS_MOOF,
                    &track_id.to_be_bytes(),
                );
                traf.extend(full(b"tfdt", 1, 0, &decode_time.to_be_bytes()));
                let mut trun = (samples.len() as u32).to_be_bytes().to_vec();
                trun.extend_from_slice(&data_offsets[index].to_be_bytes());
                for &(duration, size, sync) in samples.iter() {
                    trun.extend_from_slice(&duration.to_be_bytes());
                    trun.extend_from_slice(&size.to_be_bytes());
                    trun.extend_from_slice(
                        &(if sync { 0 } else { SAMPLE_IS_NON_SYNC }).to_be_bytes(),
                    );
                }
                traf.extend(full(
                    b"trun",
                    0,
                    TRUN_DATA_OFFSET | TRUN_SAMPLE_DURATION | TRUN_SAMPLE_SIZE | TRUN_SAMPLE_FLAGS,
                    &trun,
                ));
                moof.extend(make_box(b"traf", &traf));
            }
            make_box(b"moof", &moof)
        };
        let moof_len = build(&vec![0; tracks.len()]).len() as u32;
        let mut offsets = Vec::new();
        let mut cursor = moof_len + 8;
        for payload in payloads {
            offsets.push(cursor);
            cursor += payload.len() as u32;
        }
        let mut out = build(&offsets);
        out.extend(make_box(b"mdat", &payloads.concat()));
        out
    }

    fn sample_file() -> Vec<u8> {
        let mut moov = media_header(b"mvhd", 1000);
        moov.extend(trak(1, 48_000));
        moov.extend(trak(2, 30_000));
        let mut mvex = trex(1);
        mvex.extend(trex(2));
        moov.extend(make_box(b"mvex", &mvex));

        let mut file = make_box(b"ftyp", b"isom\0\0\0\0isom");
        file.extend(make_box(b"moov", &moov));
        file.extend(fragment(
            1,
            &[
                (1, 0, &[(1024, 3, true), (1024, 3, true)]),
                (2, 0, &[(1000, 4, true), (1000, 2, false)]),
            ],
            &[b"AAABBB".to_vec(), b"VVVVWW".to_vec()],
        ));
        file.extend(fragment(
            2,
            &[(1, 2048, &[(1024, 3, true)]), (2, 2000, &[(1000, 4, true)])],
            &[b"CCC".to_vec(), b"XXXX".to_vec()],
        ));
        file
    }

    fn temp_dir(name: &str) -> std::path::PathBuf {
        let dir =
            std::env::temp_dir().join(format!("mirrorsim-faststart-{name}-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn find_path<'a>(data: &'a [u8], path: &[&[u8; 4]]) -> &'a [u8] {
        let mut region: &[u8] = data;
        for (depth, kind) in path.iter().enumerate() {
            let boxes = boxes_in(region, 0, region.len()).unwrap();
            let found = boxes
                .iter()
                .find(|value| &value.kind == *kind)
                .unwrap_or_else(|| panic!("missing {}", fourcc(kind)));
            region = if depth + 1 == path.len() {
                raw(region, found)
            } else {
                payload(region, found)
            };
        }
        region
    }

    #[test]
    fn rewrites_fragments_into_an_indexed_seekable_file() {
        let dir = temp_dir("rewrite");
        let input = dir.join("in.mp4");
        let output = dir.join("out.mp4");
        std::fs::write(&input, sample_file()).unwrap();

        assert!(is_fragmented(&input).unwrap());
        rewrite_fragmented(&input, &output).unwrap();
        assert!(!is_fragmented(&output).unwrap());

        let data = std::fs::read(&output).unwrap();
        let top = boxes_in(&data, 0, data.len()).unwrap();
        let kinds: Vec<String> = top.iter().map(|value| fourcc(&value.kind)).collect();
        assert_eq!(kinds, ["ftyp", "moov", "mdat"]);

        // Movie duration: video 3000/30000 s = 100 ms, audio 3072/48000 s = 64 ms.
        let mvhd = find_path(&data, &[b"moov", b"mvhd"]);
        assert_eq!(read_u32(mvhd, 8 + 16).unwrap(), 100);

        // Samples are copied in their original interleaved order.
        let mdat = top.iter().find(|value| &value.kind == b"mdat").unwrap();
        assert_eq!(payload(&data, mdat), b"AAABBBVVVVWWCCCXXXX");

        // Video keeps its keyframe index and chunk offsets point into mdat.
        let moov = find_path(&data, &[b"moov"]);
        let moov_boxes = boxes_in(moov, 8, moov.len()).unwrap();
        let video_trak = moov_boxes
            .iter()
            .filter(|value| &value.kind == b"trak")
            .nth(1)
            .unwrap();
        let video = raw(moov, video_trak);
        let stbl = find_path(video, &[b"trak", b"mdia", b"minf", b"stbl"]);
        let stbl_boxes = boxes_in(stbl, 8, stbl.len()).unwrap();
        let stss = child(&stbl_boxes, b"stss").expect("video has non-sync samples");
        assert_eq!(
            payload(stbl, stss),
            [0, 0, 0, 0, 0, 0, 0, 2, 0, 0, 0, 1, 0, 0, 0, 3]
        );
        let stco = child(&stbl_boxes, b"stco").unwrap();
        let stco_payload = payload(stbl, stco);
        let first_video_chunk = read_u32(stco_payload, 8).unwrap() as usize;
        assert_eq!(&data[first_video_chunk..first_video_chunk + 4], b"VVVV");
        let second_video_chunk = read_u32(stco_payload, 12).unwrap() as usize;
        assert_eq!(&data[second_video_chunk..second_video_chunk + 4], b"XXXX");

        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn regular_mp4_files_are_left_alone() {
        let dir = temp_dir("regular");
        let input = dir.join("in.mp4");
        let mut moov = media_header(b"mvhd", 1000);
        moov.extend(trak(1, 48_000));
        let mut file = make_box(b"ftyp", b"isom\0\0\0\0isom");
        file.extend(make_box(b"moov", &moov));
        file.extend(make_box(b"mdat", b""));
        std::fs::write(&input, file).unwrap();
        assert!(!is_fragmented(&input).unwrap());
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn keeps_fragment_timestamps_across_gaps() {
        let mut track = TrackSamples::new(1);
        track.align_to(0);
        track.push_duration(1024);
        track.push_duration(1024);
        // The next fragment starts 30 ticks late; the gap joins the last sample.
        track.align_to(2078);
        track.push_duration(1024);
        assert_eq!(track.durations, [1024, 1054, 1024]);
        // A fragment that starts early shortens the previous sample instead.
        track.align_to(3092);
        assert_eq!(track.durations, [1024, 1054, 1014]);
        assert_eq!(track.media_duration(), 3092);
    }

    #[test]
    fn delays_a_track_that_starts_late_with_an_edit_list() {
        let samples = TrackSamples {
            track_id: 1,
            first_decode_time: Some(4800),
            durations: vec![1024],
            durations_sum: 1024,
            sizes: vec![3],
            composition_offsets: vec![0],
            sync: vec![true],
            chunks: vec![(0, 1)],
        };
        let lead_in = scale(samples.first_decode_time.unwrap(), 48_000, 1000);
        assert_eq!(lead_in, 100);
        let edts = build_edit_list(lead_in, 21);
        let elst = find_path(&edts, &[b"edts", b"elst"]);
        assert_eq!(read_u32(elst, 12).unwrap(), 2);
        assert_eq!(read_u64(elst, 16).unwrap(), 100);
    }
}
