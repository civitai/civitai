/**
 * Reads the container-level `prompt` / `workflow` tags that ComfyUI (SaveVideo, SaveWEBM) and
 * VideoHelperSuite's Video Combine write into mp4 (QuickTime `mdta` keys, via
 * `movflags=use_metadata_tags`) and Matroska/WebM (global SimpleTags).
 *
 * Runs in the browser on untrusted uploads: every walk is capped in iterations and bytes read,
 * and anything malformed yields `{}` rather than a throw.
 */

type VideoTags = Partial<Record<VideoTagKey, string>>;
type VideoTagKey = (typeof VIDEO_TAG_KEYS)[number];
const VIDEO_TAG_KEYS = ['prompt', 'workflow'] as const;

const MAX_ELEMENTS = 10_000;
const MAX_META_BYTES = 8 * 1024 * 1024;
const MAX_DEPTH = 6;

type Reader = (offset: number, length: number) => Promise<Uint8Array>;

const utf8 = new TextDecoder('utf-8');

class Budget {
  private remaining = MAX_ELEMENTS;
  step() {
    if (--this.remaining < 0) throw new MalformedError();
  }
}

class MalformedError extends Error {}

export async function readVideoTags(file: Blob): Promise<VideoTags> {
  const read: Reader = async (offset, length) =>
    new Uint8Array(await file.slice(offset, offset + length).arrayBuffer());

  try {
    const head = await read(0, 12);
    if (head.length < 8) return {};
    if (readU32(head, 0) === 0x1a45dfa3) return await readMatroskaTags(read, file.size);
    if (fourcc(head, 4) === 'ftyp') return await readMp4Tags(read, file.size);
    return {};
  } catch {
    return {};
  }
}

// #region mp4
type Box = { type: string; start: number; body: number; end: number };

async function* mp4Boxes(read: Reader, start: number, end: number, budget: Budget) {
  let offset = start;
  while (offset + 8 <= end) {
    budget.step();
    const header = await read(offset, 16);
    if (header.length < 8) return;
    let size = readU32(header, 0);
    const type = fourcc(header, 4);
    let headerSize = 8;
    if (size === 1) {
      if (header.length < 16) throw new MalformedError();
      size = readU32(header, 8) * 2 ** 32 + readU32(header, 12);
      headerSize = 16;
    } else if (size === 0) {
      size = end - offset;
    }
    if (size < headerSize || offset + size > end) throw new MalformedError();
    yield { type, start: offset, body: offset + headerSize, end: offset + size } satisfies Box;
    offset += size;
  }
}

async function findBox(read: Reader, start: number, end: number, type: string, budget: Budget) {
  for await (const box of mp4Boxes(read, start, end, budget)) if (box.type === type) return box;
  return undefined;
}

async function readMp4Tags(read: Reader, fileSize: number): Promise<VideoTags> {
  const budget = new Budget();
  const moov = await findBox(read, 0, fileSize, 'moov', budget);
  if (!moov) return {};

  // ffmpeg nests `meta` in `udta`; Apple writers put it directly under `moov`.
  const metas: Box[] = [];
  for await (const box of mp4Boxes(read, moov.body, moov.end, budget)) {
    if (box.type === 'meta') metas.push(box);
    if (box.type === 'udta') {
      const meta = await findBox(read, box.body, box.end, 'meta', budget);
      if (meta) metas.push(meta);
    }
  }

  for (const meta of metas) {
    const length = meta.end - meta.body;
    if (length > MAX_META_BYTES) continue;
    const tags = parseMp4Meta(await read(meta.body, length));
    if (Object.keys(tags).length) return tags;
  }
  return {};
}

function parseMp4Meta(bytes: Uint8Array): VideoTags {
  // `meta` is a full box (4 bytes version/flags) in ISO BMFF but a plain box in QuickTime.
  const start = fourcc(bytes, 4) === 'hdlr' ? 0 : 4;
  const children = syncBoxes(bytes, start, bytes.length);
  const keys = children.find((b) => b.type === 'keys');
  const ilst = children.find((b) => b.type === 'ilst');
  if (!keys || !ilst) return {};

  const names: string[] = [];
  const count = readU32(bytes, keys.body + 4);
  let offset = keys.body + 8;
  for (let i = 0; i < count && offset + 8 <= keys.end && i < MAX_ELEMENTS; i++) {
    const size = readU32(bytes, offset);
    if (size < 8 || offset + size > keys.end) break;
    names.push(decodeUtf8(bytes.subarray(offset + 8, offset + size)));
    offset += size;
  }

  const tags: VideoTags = {};
  for (const item of syncBoxes(bytes, ilst.body, ilst.end)) {
    const name = names[readU32(bytes, item.start + 4) - 1];
    const key = tagKey(name);
    if (!key || tags[key] !== undefined) continue;
    const data = syncBoxes(bytes, item.body, item.end).find((b) => b.type === 'data');
    // data: type indicator (4) + locale (4); type 1 is UTF-8 text
    if (!data || data.end - data.body < 8 || readU32(bytes, data.body) !== 1) continue;
    tags[key] = decodeUtf8(bytes.subarray(data.body + 8, data.end));
  }
  return tags;
}

function syncBoxes(bytes: Uint8Array, start: number, end: number) {
  const boxes: Box[] = [];
  let offset = start;
  while (offset + 8 <= end && boxes.length < MAX_ELEMENTS) {
    const size = readU32(bytes, offset);
    if (size < 8 || offset + size > end) break;
    boxes.push({
      type: fourcc(bytes, offset + 4),
      start: offset,
      body: offset + 8,
      end: offset + size,
    });
    offset += size;
  }
  return boxes;
}
// #endregion

// #region matroska
const EBML_ID = {
  segment: 0x18538067,
  tags: 0x1254c367,
  tag: 0x7373,
  simpleTag: 0x67c8,
  tagName: 0x45a3,
  tagString: 0x4487,
};

type Element = { id: number; body: number; end: number };

async function readMatroskaTags(read: Reader, fileSize: number): Promise<VideoTags> {
  const budget = new Budget();
  let segment: Element | undefined;
  for await (const el of ebmlElements(read, 0, fileSize, budget))
    if (el.id === EBML_ID.segment) {
      segment = el;
      break;
    }
  if (!segment) return {};

  const tags: VideoTags = {};
  try {
    for await (const el of ebmlElements(read, segment.body, segment.end, budget)) {
      if (el.id !== EBML_ID.tags) continue;
      const length = el.end - el.body;
      if (length > MAX_META_BYTES) continue;
      const bytes = await read(el.body, length);
      collectSimpleTags(bytes, 0, bytes.length, tags, 0, budget);
      if (VIDEO_TAG_KEYS.every((key) => tags[key] !== undefined)) break;
    }
  } catch (e) {
    // Tags precede the clusters in ffmpeg output, so an unknown-size or truncated cluster after
    // them must not discard what was already read.
    if (!(e instanceof MalformedError)) throw e;
  }
  return tags;
}

async function* ebmlElements(read: Reader, start: number, end: number, budget: Budget) {
  let offset = start;
  while (offset < end) {
    budget.step();
    const header = await read(offset, 12);
    const el = parseEbmlHeader(header, 0, header.length);
    if (!el) return;
    const body = offset + el.headerSize;
    // A Segment may be unknown-size (streamed) or cut short (truncated file); either way it runs
    // to end of file, so the tags ahead of the clusters stay readable.
    const size = el.id === EBML_ID.segment ? Math.min(el.size ?? Infinity, end - body) : el.size;
    if (size === undefined || body + size > end) throw new MalformedError();
    yield { id: el.id, body, end: body + size } satisfies Element;
    offset = body + size;
  }
}

function collectSimpleTags(
  bytes: Uint8Array,
  start: number,
  end: number,
  tags: VideoTags,
  depth: number,
  budget: Budget
) {
  if (depth > MAX_DEPTH) return;
  let offset = start;
  let name: string | undefined;
  let value: string | undefined;
  while (offset < end) {
    budget.step();
    const el = parseEbmlHeader(bytes, offset, end);
    if (!el || el.size === undefined) return;
    const body = offset + el.headerSize;
    const elEnd = body + el.size;
    if (elEnd > end) return;
    if (el.id === EBML_ID.tag || el.id === EBML_ID.simpleTag)
      collectSimpleTags(bytes, body, elEnd, tags, depth + 1, budget);
    else if (el.id === EBML_ID.tagName) name = decodeUtf8(bytes.subarray(body, elEnd));
    else if (el.id === EBML_ID.tagString) value = decodeUtf8(bytes.subarray(body, elEnd));
    offset = elEnd;
  }
  const key = tagKey(name);
  if (key && value !== undefined && tags[key] === undefined) tags[key] = value;
}

/** Returns `size: undefined` for the reserved all-ones "unknown size". */
function parseEbmlHeader(bytes: Uint8Array, offset: number, end: number) {
  const id = readVint(bytes, offset, end, false);
  if (!id || id.length > 4) return undefined;
  const size = readVint(bytes, offset + id.length, end, true);
  if (!size) return undefined;
  return {
    id: id.value,
    size: size.unknown ? undefined : size.value,
    headerSize: id.length + size.length,
  };
}

function readVint(bytes: Uint8Array, offset: number, end: number, stripMarker: boolean) {
  if (offset >= end) return undefined;
  const first = bytes[offset];
  let length = 1;
  let marker = 0x80;
  while (length <= 8 && !(first & marker)) {
    marker >>= 1;
    length++;
  }
  if (length > 8 || offset + length > end) return undefined;
  let value = stripMarker ? first & (marker - 1) : first;
  let allOnes = (first & (marker - 1)) === marker - 1;
  for (let i = 1; i < length; i++) {
    value = value * 256 + bytes[offset + i];
    if (bytes[offset + i] !== 0xff) allOnes = false;
  }
  return { value, length, unknown: stripMarker && allOnes };
}
// #endregion

function tagKey(name: string | undefined): VideoTagKey | undefined {
  const lower = name?.toLowerCase();
  return VIDEO_TAG_KEYS.find((key) => key === lower);
}

function readU32(bytes: Uint8Array, offset: number) {
  if (offset + 4 > bytes.length) throw new MalformedError();
  return (
    ((bytes[offset] << 24) |
      (bytes[offset + 1] << 16) |
      (bytes[offset + 2] << 8) |
      bytes[offset + 3]) >>>
    0
  );
}

function fourcc(bytes: Uint8Array, offset: number) {
  if (offset + 4 > bytes.length) return '';
  return String.fromCharCode(
    bytes[offset],
    bytes[offset + 1],
    bytes[offset + 2],
    bytes[offset + 3]
  );
}

function decodeUtf8(bytes: Uint8Array) {
  return utf8.decode(bytes);
}
