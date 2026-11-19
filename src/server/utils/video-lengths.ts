/**
 * Every length a video file states or implies, read from the bytes themselves: the header fields a
 * writer sets, and the length the samples or blocks actually span. A file whose header claims less
 * than its stream holds shows up as a disagreement between the two.
 *
 * The bytes are the seller's, and players differ in which copy of a field they honour, so anything
 * that could make a player show what this does not measure is refused rather than guessed at:
 * a repeated field, a second video track, a track time scale, bytes past the container, more than
 * one edit, embedded attachments or cover art.
 */

/** Parsing seller bytes: past this many boxes, elements or table entries, or this long, refuse. */
const MAX_VISITS = 1_000_000;
const MAX_PARSE_MS = 2_000;
let visits = 0;
let deadline = 0;
/** Bytes in padding (mp4 free/skip, EBML Void): shown by no player, so a place to carry anything. */
const MAX_PADDING_BYTES = 64 * 1024;
let padding = 0;
const pad = (bytes: number) => {
  padding += bytes;
  if (padding > MAX_PADDING_BYTES) throw new Malformed();
};
const visit = (n = 1) => {
  visits += n;
  if (visits > MAX_VISITS || Date.now() > deadline) throw new Malformed();
};

/**
 * Seconds, one per source read; null when the file cannot be read this way. Nesting is fixed by
 * the walk (no recursion), so depth is bounded by construction.
 */
export function readVideoLengths(bytes: Uint8Array): number[] | null {
  visits = 0;
  padding = 0;
  deadline = Date.now() + MAX_PARSE_MS;
  try {
    const lengths =
      fourcc(bytes, 4) === 'ftyp'
        ? mp4Lengths(bytes)
        : u32(bytes, 0) === EBML.header
        ? matroskaLengths(bytes)
        : null;
    // A NaN or infinite field would slip through every comparison made with it.
    return lengths?.length && lengths.every((s) => Number.isFinite(s) && s >= 0) ? lengths : null;
  } catch {
    return null;
  }
}

class Malformed extends Error {}

const u32 = (b: Uint8Array, o: number) => {
  if (o < 0 || o + 4 > b.length) throw new Malformed();
  return ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
};
const i32 = (b: Uint8Array, o: number) => u32(b, o) | 0;
const u64 = (b: Uint8Array, o: number) => u32(b, o) * 2 ** 32 + u32(b, o + 4);
const fourcc = (b: Uint8Array, o: number) =>
  o + 4 > b.length ? '' : String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]);

// #region mp4
const SOUND_FORMATS = new Set([
  'mp4a',
  'Opus',
  'fLaC',
  'ac-3',
  'ec-3',
  '.mp3',
  'alac',
  'lpcm',
  'sowt',
  'twos',
  'ipcm',
]);
const MAX_REORDER_FRAMES = 8;
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
    const type = fourcc(b, offset + 4);
    if (type === 'free' || type === 'skip') pad(size - header);
    out.push({ type, body: offset + header, end: offset + size });
    offset += size;
  }
  if (offset !== end) throw new Malformed();
  return out;
}

/** A parent's children by type; a type read here that appears twice is refused. */
function children(b: Uint8Array, box: Box | undefined) {
  const byType = new Map<string, Box[]>();
  if (box)
    for (const c of boxes(b, box.body, box.end)) {
      const list = byType.get(c.type);
      if (list) list.push(c);
      else byType.set(c.type, [c]);
    }
  return {
    one(type: string) {
      const found = byType.get(type);
      if (found && found.length > 1) throw new Malformed();
      return found?.[0];
    },
    all: (type: string) => byType.get(type) ?? [],
    has: (type: string) => byType.has(type),
  };
}

/** A full box's table: `count` entries of `size` bytes from `at`, all inside the box. */
function table(b: Uint8Array, box: Box, at: number, size: number) {
  const count = u32(b, at);
  if (at + 4 + count * size > box.end) throw new Malformed();
  visit(count);
  return { count, start: at + 4 };
}

/** mvhd and mdhd share a layout: version, then (32 or 64 bit) times, timescale, duration. */
function timescaleAndDuration(b: Uint8Array, box: Box) {
  const v1 = b[box.body] === 1;
  if (box.body + (v1 ? 32 : 20) > box.end) throw new Malformed();
  return v1
    ? { timescale: u32(b, box.body + 20), duration: u64(b, box.body + 24) }
    : { timescale: u32(b, box.body + 12), duration: u32(b, box.body + 16) };
}

function mp4Lengths(b: Uint8Array): number[] | null {
  const top = children(b, { type: '', body: 0, end: b.length });
  // A fragmented file keeps its samples outside the sample table, where it cannot be summed.
  if (top.has('moof') || top.has('meta')) return null;
  const moovBox = top.one('moov');
  if (!moovBox) return null;
  // Cover art is a picture a player shows that the scan never sees.
  if (Buffer.from(b.subarray(moovBox.body, moovBox.end)).includes('covr')) return null;
  const moov = children(b, moovBox);
  const mvhd = moov.one('mvhd');
  if (!mvhd || moov.has('mvex')) return null;
  const movie = timescaleAndDuration(b, mvhd);
  if (!movie.timescale) return null;
  const lengths = [movie.duration / movie.timescale];

  const traks = moov.all('trak');
  if (!traks.length) return null;
  let videoTracks = 0;
  for (const trakBox of traks) {
    const trak = children(b, trakBox);
    const tkhd = trak.one('tkhd');
    if (!tkhd) return null;
    const tv1 = b[tkhd.body] === 1;
    if (tkhd.body + (tv1 ? 36 : 24) > tkhd.end) return null;
    lengths.push((tv1 ? u64(b, tkhd.body + 28) : u32(b, tkhd.body + 20)) / movie.timescale);

    const elst = children(b, trak.one('edts')).one('elst');
    if (elst) {
      const v1 = b[elst.body] === 1;
      const entrySize = v1 ? 20 : 12;
      const { count, start } = table(b, elst, elst.body + 4, entrySize);
      let sum = 0;
      let mediaEdits = 0;
      for (let i = 0; i < count; i++) {
        const entry = start + i * entrySize;
        sum += v1 ? u64(b, entry) : u32(b, entry);
        const empty = v1
          ? u32(b, entry + 8) === 0xffffffff && u32(b, entry + 12) === 0xffffffff
          : i32(b, entry + 4) === -1;
        if (!empty) mediaEdits++;
      }
      // Two edits can show one stretch of the media twice and never another.
      if (mediaEdits > 1) return null;
      lengths.push(sum / movie.timescale);
    }

    const mdia = children(b, trak.one('mdia'));
    // Only one picture track and sound: a subtitle or other track can draw what the scan never sees.
    const hdlr = mdia.one('hdlr');
    const handler = hdlr ? fourcc(b, hdlr.body + 8) : '';
    if (handler !== 'vide' && handler !== 'soun') return null;
    if (handler === 'vide') videoTracks++;
    const mdhd = mdia.one('mdhd');
    const stbl = children(b, children(b, mdia.one('minf')).one('stbl'));
    // One sample format, and a sound track's must be a sound codec: a player decodes by format.
    const stsd = stbl.one('stsd');
    if (!stsd || stsd.body + 16 > stsd.end || u32(b, stsd.body + 4) !== 1) return null;
    if (handler === 'soun' && !SOUND_FORMATS.has(fourcc(b, stsd.body + 12))) return null;
    const stts = stbl.one('stts');
    const stsz = stbl.one('stsz');
    if (!mdhd || !stts || !stsz) return null;
    const media = timescaleAndDuration(b, mdhd);
    if (!media.timescale) return null;
    lengths.push(media.duration / media.timescale);
    const timing = table(b, stts, stts.body + 4, 8);
    let samples = 0;
    let ticks = 0;
    let longestFrame = 0;
    for (let i = 0; i < timing.count; i++) {
      const count = u32(b, timing.start + i * 8);
      const delta = u32(b, timing.start + i * 8 + 4);
      samples += count;
      ticks += count * delta;
      longestFrame = Math.max(longestFrame, delta);
    }
    // Samples the timing table does not cover would still be played.
    if (stsz.body + 12 > stsz.end || samples !== u32(b, stsz.body + 8)) return null;
    // A composition offset can show a sample well after the timing table ends.
    const ctts = stbl.one('ctts');
    if (ctts) {
      const offsets = table(b, ctts, ctts.body + 4, 8);
      for (let i = 0; i < offsets.count; i++) {
        // Encoders reorder a few frames; more could show a frame well past the timing table.
        const offset = Math.abs(i32(b, offsets.start + i * 8 + 4));
        if (offset > Math.max(media.timescale, MAX_REORDER_FRAMES * longestFrame)) return null;
      }
    }
    lengths.push(ticks / media.timescale);
  }
  // Which of two video tracks a player or the scan picks is not this code's to decide.
  if (videoTracks !== 1) return null;
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
  tracks: 0x1654ae6b,
  trackEntry: 0xae,
  trackType: 0x83,
  trackTimecodeScale: 0x23314f,
  codecId: 0x86,
  attachments: 0x1941a469,
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
  EBML.tracks,
  EBML.attachments,
  0x114d9b74, // SeekHead
  0x1c53bb6b, // Cues
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
const EBML_VOID = 0xec;
const EBML_CRC = 0xbf;

function element(b: Uint8Array, offset: number): Element {
  visit();
  const id = vint(b, offset, false);
  if (id.length > 4) throw new Malformed();
  const size = vint(b, offset + id.length, true);
  const body = offset + id.length + size.length;
  if (!size.unknown && body + size.value > b.length) throw new Malformed();
  if (id.value === EBML_VOID && !size.unknown) pad(size.value);
  return { id: id.value, body, end: size.unknown ? undefined : body + size.value };
}

/** The sized children of a sized element, each inside it. */
function sized(b: Uint8Array, start: number, end: number) {
  const out: { id: number; body: number; end: number }[] = [];
  for (let o = start; o < end; ) {
    const el = element(b, o);
    // A child running past its parent would hide the siblings it covers.
    if (el.end === undefined || el.end > end) throw new Malformed();
    out.push({ id: el.id, body: el.body, end: el.end });
    o = el.end;
  }
  return out;
}

const uint = (b: Uint8Array, start: number, end: number) => {
  if (end - start > 8) throw new Malformed();
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

function only<T extends { id: number }>(list: T[], id: number) {
  const found = list.filter((el) => el.id === id);
  if (found.length > 1) throw new Malformed();
  return found[0];
}

function matroskaLengths(b: Uint8Array): number[] | null {
  const header = element(b, 0);
  if (header.end === undefined) return null;
  const segment = element(b, header.end);
  if (segment.id !== EBML.segment) return null;
  // Bytes past the Segment (a second one, say) are something a player may show and this never read.
  if (segment.end !== undefined && segment.end !== b.length) return null;
  const segmentEnd = b.length;

  let scale: number | undefined;
  let declared: number | undefined;
  let last: number | undefined;
  let infos = 0;
  let trackLists = 0;
  let videoTracks = 0;
  let offset = segment.body;
  while (offset < segmentEnd) {
    const el = element(b, offset);
    if (el.id === EBML.cluster) {
      let o = el.body;
      const end = el.end ?? segmentEnd;
      let base: number | undefined;
      while (o < end) {
        const part = element(b, o);
        if (el.end === undefined && SEGMENT_CHILDREN.has(part.id)) break;
        if (part.end === undefined || part.end > end) return null;
        if (part.id === EBML.timecode) {
          if (base !== undefined) return null;
          base = uint(b, part.body, part.end);
        } else if (part.id === EBML.simpleBlock) {
          if (base === undefined) return null;
          last = Math.max(last ?? -Infinity, base + blockOffset(b, part.body));
        } else if (part.id === EBML.blockGroup) {
          if (base === undefined) return null;
          const group = sized(b, part.body, part.end);
          const block = only(group, EBML.block);
          const duration = only(group, EBML.blockDuration);
          if (block)
            last = Math.max(
              last ?? -Infinity,
              base +
                blockOffset(b, block.body) +
                (duration ? uint(b, duration.body, duration.end) : 0)
            );
        }
        o = part.end;
      }
      offset = o;
      continue;
    }
    if (el.end === undefined || el.end > segmentEnd) return null;
    // Only what a Segment holds: another Segment or EBML document inside is video never read.
    if (!SEGMENT_CHILDREN.has(el.id) && el.id !== EBML_VOID && el.id !== EBML_CRC) return null;
    if (el.id === EBML.attachments) return null;
    if (el.id === EBML.info) {
      if (++infos > 1) return null;
      const fields = sized(b, el.body, el.end);
      const scaleField = only(fields, EBML.timecodeScale);
      const durationField = only(fields, EBML.duration);
      if (scaleField) scale = uint(b, scaleField.body, scaleField.end);
      if (durationField) declared = float(b, durationField.body, durationField.end);
    } else if (el.id === EBML.tracks) {
      if (++trackLists > 1) return null;
      for (const entry of sized(b, el.body, el.end)) {
        if (entry.id !== EBML.trackEntry) continue;
        const fields = sized(b, entry.body, entry.end);
        // Only one picture track and sound, each with a codec of its kind.
        const type = only(fields, EBML.trackType);
        const kind = type ? uint(b, type.body, type.end) : 0;
        const codec = only(fields, EBML.codecId);
        const codecId = codec
          ? Buffer.from(b.subarray(codec.body, codec.end)).toString('latin1')
          : '';
        if (kind === 1 && codecId.startsWith('V_')) videoTracks++;
        else if (!(kind === 2 && codecId.startsWith('A_'))) return null;
        // A track time scale stretches every block time on that track.
        const trackScale = only(fields, EBML.trackTimecodeScale);
        if (trackScale && float(b, trackScale.body, trackScale.end) !== 1) return null;
      }
    }
    offset = el.end;
  }
  if (videoTracks !== 1) return null;
  const ticksToNs = scale ?? 1_000_000;
  if (last === undefined || !ticksToNs) return null;
  const seconds = (ticks: number) => (ticks * ticksToNs) / 1e9;
  return declared === undefined ? [seconds(last)] : [seconds(declared), seconds(last)];
}
// #endregion
