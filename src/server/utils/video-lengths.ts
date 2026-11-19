/**
 * Every length a video file states or implies, read from the bytes themselves: the header fields a
 * writer sets, and the length the samples or blocks actually span. A file whose header claims less
 * than its stream holds shows up as a disagreement between the two.
 */

/** Parsing seller bytes: past this many boxes or elements, or this long, the file is refused. */
const MAX_VISITS = 1_000_000;
const MAX_PARSE_MS = 2_000;
let visits = 0;
let deadline = 0;
const visit = () => {
  if (++visits > MAX_VISITS || (visits % 4096 === 0 && Date.now() > deadline))
    throw new Malformed();
};

/**
 * Seconds, one per source read; null when the file cannot be read this way. Nesting is fixed by
 * the walk (no recursion), so depth is bounded by construction.
 */
export function readVideoLengths(bytes: Uint8Array): number[] | null {
  visits = 0;
  deadline = Date.now() + MAX_PARSE_MS;
  try {
    if (fourcc(bytes, 4) === 'ftyp') return mp4Lengths(bytes);
    if (u32(bytes, 0) === EBML.header) return matroskaLengths(bytes);
    return null;
  } catch {
    return null;
  }
}

class Malformed extends Error {}

const u32 = (b: Uint8Array, o: number) => {
  if (o < 0 || o + 4 > b.length) throw new Malformed();
  return ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
};
const u64 = (b: Uint8Array, o: number) => u32(b, o) * 2 ** 32 + u32(b, o + 4);
const fourcc = (b: Uint8Array, o: number) =>
  o + 4 > b.length ? '' : String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]);

// #region mp4
type Box = { type: string; body: number; end: number };

function boxes(b: Uint8Array, start: number, end: number): Box[] {
  const out: Box[] = [];
  let offset = start;
  while (offset + 8 <= end) {
    visit();
    let size = u32(b, offset);
    let header = 8;
    if (size === 1) {
      size = u64(b, offset + 8);
      header = 16;
    } else if (size === 0) size = end - offset;
    if (size < header || offset + size > end) throw new Malformed();
    out.push({ type: fourcc(b, offset + 4), body: offset + header, end: offset + size });
    offset += size;
  }
  return out;
}

const child = (b: Uint8Array, box: Box | undefined, type: string) =>
  box && boxes(b, box.body, box.end).find((c) => c.type === type);

/** mvhd and mdhd share a layout: version, then (32 or 64 bit) times, timescale, duration. */
function timescaleAndDuration(b: Uint8Array, box: Box) {
  return b[box.body] === 1
    ? { timescale: u32(b, box.body + 20), duration: u64(b, box.body + 24) }
    : { timescale: u32(b, box.body + 12), duration: u32(b, box.body + 16) };
}

function mp4Lengths(b: Uint8Array): number[] | null {
  const top = boxes(b, 0, b.length);
  // A fragmented file keeps its samples outside the sample table, where it cannot be summed.
  if (top.some((box) => box.type === 'moof')) return null;
  const moov = top.find((box) => box.type === 'moov');
  const mvhd = child(b, moov, 'mvhd');
  if (!moov || !mvhd || child(b, moov, 'mvex')) return null;
  const movie = timescaleAndDuration(b, mvhd);
  if (!movie.timescale) return null;
  const lengths = [movie.duration / movie.timescale];

  const traks = boxes(b, moov.body, moov.end).filter((box) => box.type === 'trak');
  if (!traks.length) return null;
  for (const trak of traks) {
    const tkhd = child(b, trak, 'tkhd');
    if (tkhd) {
      const duration = b[tkhd.body] === 1 ? u64(b, tkhd.body + 28) : u32(b, tkhd.body + 20);
      lengths.push(duration / movie.timescale);
    }
    const elst = child(b, child(b, trak, 'edts'), 'elst');
    if (elst) {
      const v1 = b[elst.body] === 1;
      const count = u32(b, elst.body + 4);
      let sum = 0;
      if (count > MAX_VISITS) return null;
      for (let i = 0; i < count; i++) {
        const entry = elst.body + 8 + i * (v1 ? 20 : 12);
        sum += v1 ? u64(b, entry) : u32(b, entry);
      }
      lengths.push(sum / movie.timescale);
    }
    const mdia = child(b, trak, 'mdia');
    const mdhd = child(b, mdia, 'mdhd');
    const stbl = child(b, child(b, mdia, 'minf'), 'stbl');
    const stts = child(b, stbl, 'stts');
    const stsz = child(b, stbl, 'stsz');
    if (!mdhd || !stts || !stsz) return null;
    const media = timescaleAndDuration(b, mdhd);
    if (!media.timescale) return null;
    lengths.push(media.duration / media.timescale);
    const entries = u32(b, stts.body + 4);
    if (entries > MAX_VISITS) return null;
    let samples = 0;
    let ticks = 0;
    for (let i = 0; i < entries; i++) {
      const count = u32(b, stts.body + 8 + i * 8);
      samples += count;
      ticks += count * u32(b, stts.body + 12 + i * 8);
    }
    // Samples the timing table does not cover would still be played.
    if (samples !== u32(b, stsz.body + 8)) return null;
    lengths.push(ticks / media.timescale);
  }
  return lengths;
}
// #endregion

// #region matroska
const EBML = {
  header: 0x1a45dfa3,
  segment: 0x18538067,
  info: 0x1549a966,
  timecodeScale: 0x2ad7b1,
  duration: 0x4489,
  cluster: 0x1f43b675,
  timecode: 0xe7,
  simpleBlock: 0xa3,
  blockGroup: 0xa0,
  block: 0xa1,
  blockDuration: 0x9b,
};
/** The children of a Segment, any of which ends a Cluster whose size is unknown. */
const SEGMENT_CHILDREN = new Set([
  EBML.info,
  EBML.cluster,
  0x114d9b74, // SeekHead
  0x1654ae6b, // Tracks
  0x1c53bb6b, // Cues
  0x1941a469, // Attachments
  0x1043a770, // Chapters
  0x1254c367, // Tags
]);

function vint(b: Uint8Array, offset: number, stripMarker: boolean) {
  if (offset >= b.length) throw new Malformed();
  const first = b[offset];
  let length = 1;
  let marker = 0x80;
  while (length <= 8 && !(first & marker)) {
    marker >>= 1;
    length++;
  }
  if (length > 8 || offset + length > b.length) throw new Malformed();
  let value = stripMarker ? first & (marker - 1) : first;
  let allOnes = (first & (marker - 1)) === marker - 1;
  for (let i = 1; i < length; i++) {
    value = value * 256 + b[offset + i];
    if (b[offset + i] !== 0xff) allOnes = false;
  }
  return { value, length, unknown: stripMarker && allOnes };
}

type Element = { id: number; body: number; end: number | undefined };

function element(b: Uint8Array, offset: number): Element {
  visit();
  const id = vint(b, offset, false);
  if (id.length > 4) throw new Malformed();
  const size = vint(b, offset + id.length, true);
  const body = offset + id.length + size.length;
  if (!size.unknown && body + size.value > b.length) throw new Malformed();
  return { id: id.value, body, end: size.unknown ? undefined : body + size.value };
}

const uint = (b: Uint8Array, start: number, end: number) => {
  let value = 0;
  for (let i = start; i < end; i++) value = value * 256 + b[i];
  return value;
};

function float(b: Uint8Array, start: number, end: number) {
  const view = new DataView(b.buffer, b.byteOffset + start, end - start);
  if (end - start === 4) return view.getFloat32(0);
  if (end - start === 8) return view.getFloat64(0);
  throw new Malformed();
}

/** A block's timestamp relative to its cluster: after the track number, a signed 16-bit value. */
function blockOffset(b: Uint8Array, body: number) {
  const track = vint(b, body, true);
  const at = body + track.length;
  if (at + 2 > b.length) throw new Malformed();
  const raw = (b[at] << 8) | b[at + 1];
  return raw & 0x8000 ? raw - 0x10000 : raw;
}

function matroskaLengths(b: Uint8Array): number[] | null {
  const header = element(b, 0);
  if (header.end === undefined) return null;
  const segment = element(b, header.end);
  if (segment.id !== EBML.segment) return null;
  const segmentEnd = segment.end ?? b.length;

  let scale = 1_000_000;
  let declared: number | undefined;
  let last: number | undefined;
  let offset = segment.body;
  while (offset < segmentEnd) {
    const el = element(b, offset);
    if (el.id === EBML.info) {
      if (el.end === undefined) return null;
      for (let o = el.body; o < el.end; ) {
        const field = element(b, o);
        if (field.end === undefined) return null;
        if (field.id === EBML.timecodeScale) scale = uint(b, field.body, field.end);
        if (field.id === EBML.duration) declared = float(b, field.body, field.end);
        o = field.end;
      }
      offset = el.end;
    } else if (el.id === EBML.cluster) {
      let base = 0;
      let o = el.body;
      const end = el.end ?? segmentEnd;
      while (o < end) {
        const part = element(b, o);
        if (el.end === undefined && SEGMENT_CHILDREN.has(part.id)) break;
        if (part.end === undefined) return null;
        if (part.id === EBML.timecode) base = uint(b, part.body, part.end);
        else if (part.id === EBML.simpleBlock)
          last = Math.max(last ?? -Infinity, base + blockOffset(b, part.body));
        else if (part.id === EBML.blockGroup) {
          let at: number | undefined;
          let duration = 0;
          for (let g = part.body; g < part.end; ) {
            const inner = element(b, g);
            if (inner.end === undefined) return null;
            if (inner.id === EBML.block) at = base + blockOffset(b, inner.body);
            if (inner.id === EBML.blockDuration) duration = uint(b, inner.body, inner.end);
            g = inner.end;
          }
          if (at !== undefined) last = Math.max(last ?? -Infinity, at + duration);
        }
        o = part.end;
      }
      offset = o;
    } else {
      if (el.end === undefined) return null;
      offset = el.end;
    }
  }
  if (last === undefined || !scale) return null;
  const seconds = (ticks: number) => (ticks * scale) / 1e9;
  return declared === undefined ? [seconds(last)] : [seconds(declared), seconds(last)];
}
// #endregion
