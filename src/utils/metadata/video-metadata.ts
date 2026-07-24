const MAX_VALUE_BYTES = 2 * 1024 * 1024;
const MAX_TOTAL_METADATA_BYTES = 4 * 1024 * 1024;
const MAX_ELEMENTS = 10_000;
const MAX_KEY_BYTES = 1024;
const MAX_SIMPLE_TAG_DEPTH = 16;

const MP4_FTYP = 'ftyp';
const EBML_HEADER_ID = 0x1a45dfa3;
const EBML_SEGMENT_ID = 0x18538067;
const EBML_TAGS_ID = 0x1254c367;
const EBML_TAG_ID = 0x7373;
const EBML_SIMPLE_TAG_ID = 0x67c8;
const EBML_TAG_NAME_ID = 0x45a3;
const EBML_TAG_STRING_ID = 0x4487;

type VideoContainer = 'mp4' | 'webm';
type MetadataValue = string | Record<string, unknown>;

type Mp4Box = {
  end: number;
  payloadStart: number;
  type: string;
  typeBytes: Uint8Array;
};

type EbmlElement = {
  id: number;
  dataStart: number;
  end: number;
  unknownSize: boolean;
};

class InvalidVideoMetadata extends Error {}

const utf8Decoder = new TextDecoder('utf-8', { fatal: true });

function readUint32(bytes: Uint8Array, offset = 0): number {
  return (
    bytes[offset] * 0x1000000 +
    bytes[offset + 1] * 0x10000 +
    bytes[offset + 2] * 0x100 +
    bytes[offset + 3]
  );
}

function readAscii(bytes: Uint8Array, offset: number, length: number): string {
  let result = '';
  for (let i = offset; i < offset + length; i++) result += String.fromCharCode(bytes[i]);
  return result;
}

async function readBytes(blob: Blob, offset: number, length: number): Promise<Uint8Array> {
  if (
    !Number.isSafeInteger(offset) ||
    !Number.isSafeInteger(length) ||
    offset < 0 ||
    length < 0 ||
    offset + length > blob.size
  ) {
    throw new InvalidVideoMetadata();
  }
  return new Uint8Array(await blob.slice(offset, offset + length).arrayBuffer());
}

function decodeUtf8(bytes: Uint8Array): string {
  return utf8Decoder.decode(bytes).replace(/\0+$/, '');
}

function normalizeMetadataKey(key: string): string | undefined {
  switch (key.trim().toLowerCase()) {
    case 'prompt':
      return 'prompt';
    case 'workflow':
      return 'workflow';
    case 'parameters':
      return 'parameters';
    case 'extrametadata':
      return 'extraMetadata';
    default:
      return undefined;
  }
}

function normalizeMetadataValues(values: Map<string, string>): Record<string, MetadataValue> {
  const metadata: Record<string, MetadataValue> = {};
  for (const [key, value] of values) {
    if (key === 'extraMetadata') {
      try {
        const parsed = JSON.parse(value);
        metadata[key] =
          parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : value;
      } catch {
        metadata[key] = value;
      }
    } else {
      metadata[key] = value;
    }
  }
  return metadata;
}

export async function detectVideoContainer(blob: Blob): Promise<VideoContainer | undefined> {
  if (blob.size < 8) return undefined;
  try {
    const signature = await readBytes(blob, 0, Math.min(blob.size, 16));
    if (readUint32(signature) === EBML_HEADER_ID) return 'webm';
    if (readAscii(signature, 4, 4) === MP4_FTYP) return 'mp4';
  } catch {}
  return undefined;
}

async function readMp4Box(blob: Blob, offset: number, end: number): Promise<Mp4Box> {
  if (end - offset < 8) throw new InvalidVideoMetadata();
  const header = await readBytes(blob, offset, Math.min(16, end - offset));
  const size32 = readUint32(header);
  const typeBytes = header.slice(4, 8);
  let headerSize = 8;
  let size = size32;

  if (size32 === 1) {
    if (header.length < 16) throw new InvalidVideoMetadata();
    const view = new DataView(header.buffer, header.byteOffset, header.byteLength);
    const extendedSize = view.getBigUint64(8);
    if (extendedSize > BigInt(Number.MAX_SAFE_INTEGER)) throw new InvalidVideoMetadata();
    size = Number(extendedSize);
    headerSize = 16;
  } else if (size32 === 0) {
    size = end - offset;
  }

  if (size < headerSize || offset + size > end) throw new InvalidVideoMetadata();
  return {
    end: offset + size,
    payloadStart: offset + headerSize,
    type: readAscii(typeBytes, 0, 4),
    typeBytes,
  };
}

async function getMp4Children(blob: Blob, start: number, end: number): Promise<Mp4Box[]> {
  const boxes: Mp4Box[] = [];
  let offset = start;
  while (offset < end) {
    if (boxes.length >= MAX_ELEMENTS) throw new InvalidVideoMetadata();
    const box = await readMp4Box(blob, offset, end);
    boxes.push(box);
    offset = box.end;
  }
  return boxes;
}

async function parseMp4Keys(blob: Blob, box: Mp4Box): Promise<Map<number, string>> {
  if (box.end - box.payloadStart < 8) throw new InvalidVideoMetadata();
  const header = await readBytes(blob, box.payloadStart, 8);
  const entryCount = readUint32(header, 4);
  if (entryCount > MAX_ELEMENTS) throw new InvalidVideoMetadata();

  const keys = new Map<number, string>();
  let offset = box.payloadStart + 8;
  for (let index = 1; index <= entryCount; index++) {
    if (box.end - offset < 8) throw new InvalidVideoMetadata();
    const entryHeader = await readBytes(blob, offset, 8);
    const entrySize = readUint32(entryHeader);
    if (entrySize < 8 || offset + entrySize > box.end) throw new InvalidVideoMetadata();
    const namespace = readAscii(entryHeader, 4, 4);
    const keyLength = entrySize - 8;
    if (namespace === 'mdta' && keyLength <= MAX_KEY_BYTES) {
      const key = decodeUtf8(await readBytes(blob, offset + 8, keyLength));
      const normalizedKey = normalizeMetadataKey(key);
      if (normalizedKey) keys.set(index, normalizedKey);
    }
    offset += entrySize;
  }
  if (offset !== box.end) throw new InvalidVideoMetadata();
  return keys;
}

async function readMp4DataValue(blob: Blob, item: Mp4Box): Promise<Uint8Array | undefined> {
  const children = await getMp4Children(blob, item.payloadStart, item.end);
  const data = children.find((box) => box.type === 'data');
  if (!data) return undefined;
  if (data.end - data.payloadStart < 8) throw new InvalidVideoMetadata();

  const dataHeader = await readBytes(blob, data.payloadStart, 8);
  const dataType = readUint32(dataHeader) & 0x00ffffff;
  if (dataType !== 1) throw new InvalidVideoMetadata();
  const valueLength = data.end - data.payloadStart - 8;
  if (valueLength > MAX_VALUE_BYTES) throw new InvalidVideoMetadata();
  return readBytes(blob, data.payloadStart + 8, valueLength);
}

async function parseMp4Meta(
  blob: Blob,
  meta: Mp4Box,
  budget: { totalBytes: number }
): Promise<Map<string, string>> {
  if (meta.end - meta.payloadStart < 4) throw new InvalidVideoMetadata();
  const children = await getMp4Children(blob, meta.payloadStart + 4, meta.end);
  const keysBox = children.find((box) => box.type === 'keys');
  const ilstBox = children.find((box) => box.type === 'ilst');
  if (!keysBox || !ilstBox) return new Map();

  const keys = await parseMp4Keys(blob, keysBox);
  if (keys.size === 0) return new Map();

  const values = new Map<string, string>();
  for (const item of await getMp4Children(blob, ilstBox.payloadStart, ilstBox.end)) {
    const key = keys.get(readUint32(item.typeBytes));
    if (!key) continue;
    const bytes = await readMp4DataValue(blob, item);
    if (!bytes) continue;
    budget.totalBytes += bytes.byteLength;
    if (budget.totalBytes > MAX_TOTAL_METADATA_BYTES) throw new InvalidVideoMetadata();
    values.set(key, decodeUtf8(bytes));
  }
  return values;
}

async function parseMp4Metadata(blob: Blob): Promise<Record<string, MetadataValue>> {
  const values = new Map<string, string>();
  const budget = { totalBytes: 0 };
  let visited = 0;
  for (const topLevel of await getMp4Children(blob, 0, blob.size)) {
    if (++visited > MAX_ELEMENTS) throw new InvalidVideoMetadata();
    if (topLevel.type !== 'moov') continue;
    for (const moovChild of await getMp4Children(blob, topLevel.payloadStart, topLevel.end)) {
      if (++visited > MAX_ELEMENTS) throw new InvalidVideoMetadata();
      if (moovChild.type !== 'udta') continue;
      for (const udtaChild of await getMp4Children(blob, moovChild.payloadStart, moovChild.end)) {
        if (++visited > MAX_ELEMENTS) throw new InvalidVideoMetadata();
        if (udtaChild.type !== 'meta') continue;
        const parsed = await parseMp4Meta(blob, udtaChild, budget);
        for (const [key, value] of parsed) values.set(key, value);
      }
    }
  }
  return normalizeMetadataValues(values);
}

function parseEbmlVint(
  bytes: Uint8Array,
  offset: number,
  maxLength: number,
  preserveMarker: boolean
): { length: number; value: number; unknown: boolean } {
  const first = bytes[offset];
  if (!first) throw new InvalidVideoMetadata();

  let length = 1;
  let marker = 0x80;
  while (!(first & marker)) {
    length++;
    marker >>= 1;
    if (length > maxLength) throw new InvalidVideoMetadata();
  }
  if (offset + length > bytes.length) throw new InvalidVideoMetadata();

  let value = preserveMarker ? first : first & (marker - 1);
  let unknown = !preserveMarker && (first & (marker - 1)) === marker - 1;
  for (let i = 1; i < length; i++) {
    value = value * 256 + bytes[offset + i];
    if (!preserveMarker && bytes[offset + i] !== 0xff) unknown = false;
  }
  if (!unknown && !Number.isSafeInteger(value)) throw new InvalidVideoMetadata();
  return { length, value, unknown };
}

async function readEbmlElement(blob: Blob, offset: number, end: number): Promise<EbmlElement> {
  if (offset >= end) throw new InvalidVideoMetadata();
  const header = await readBytes(blob, offset, Math.min(12, end - offset));
  const id = parseEbmlVint(header, 0, 4, true);
  const size = parseEbmlVint(header, id.length, 8, false);
  const dataStart = offset + id.length + size.length;
  const elementEnd = size.unknown ? end : dataStart + size.value;
  if (dataStart > end || elementEnd > end || elementEnd < dataStart)
    throw new InvalidVideoMetadata();
  return { id: id.value, dataStart, end: elementEnd, unknownSize: size.unknown };
}

async function getEbmlChildren(blob: Blob, start: number, end: number): Promise<EbmlElement[]> {
  const elements: EbmlElement[] = [];
  let offset = start;
  while (offset < end) {
    if (elements.length >= MAX_ELEMENTS) throw new InvalidVideoMetadata();
    const element = await readEbmlElement(blob, offset, end);
    if (element.unknownSize) throw new InvalidVideoMetadata();
    elements.push(element);
    offset = element.end;
  }
  return elements;
}

async function parseSimpleTag(
  blob: Blob,
  simpleTag: EbmlElement,
  values: Map<string, string>,
  budget: { totalBytes: number },
  depth: number
): Promise<void> {
  if (depth > MAX_SIMPLE_TAG_DEPTH) throw new InvalidVideoMetadata();
  let name: string | undefined;
  let stringElement: EbmlElement | undefined;
  const nested: EbmlElement[] = [];

  for (const child of await getEbmlChildren(blob, simpleTag.dataStart, simpleTag.end)) {
    if (child.id === EBML_TAG_NAME_ID) {
      const length = child.end - child.dataStart;
      if (length > MAX_KEY_BYTES) throw new InvalidVideoMetadata();
      name = decodeUtf8(await readBytes(blob, child.dataStart, length));
    } else if (child.id === EBML_TAG_STRING_ID) {
      stringElement = child;
    } else if (child.id === EBML_SIMPLE_TAG_ID) {
      nested.push(child);
    }
  }

  const key = name ? normalizeMetadataKey(name) : undefined;
  if (key && stringElement) {
    const length = stringElement.end - stringElement.dataStart;
    if (length > MAX_VALUE_BYTES) throw new InvalidVideoMetadata();
    budget.totalBytes += length;
    if (budget.totalBytes > MAX_TOTAL_METADATA_BYTES) throw new InvalidVideoMetadata();
    values.set(key, decodeUtf8(await readBytes(blob, stringElement.dataStart, length)));
  }

  for (const child of nested) await parseSimpleTag(blob, child, values, budget, depth + 1);
}

async function parseWebmTags(
  blob: Blob,
  tags: EbmlElement,
  values: Map<string, string>,
  budget: { totalBytes: number }
): Promise<void> {
  for (const tag of await getEbmlChildren(blob, tags.dataStart, tags.end)) {
    if (tag.id !== EBML_TAG_ID) continue;
    for (const child of await getEbmlChildren(blob, tag.dataStart, tag.end)) {
      if (child.id === EBML_SIMPLE_TAG_ID) {
        await parseSimpleTag(blob, child, values, budget, 0);
      }
    }
  }
}

async function parseWebmMetadata(blob: Blob): Promise<Record<string, MetadataValue>> {
  let offset = 0;
  let segment: EbmlElement | undefined;
  let elementCount = 0;
  while (offset < blob.size) {
    if (++elementCount > MAX_ELEMENTS) throw new InvalidVideoMetadata();
    const element = await readEbmlElement(blob, offset, blob.size);
    if (element.id === EBML_SEGMENT_ID) {
      segment = element;
      break;
    }
    if (element.unknownSize) throw new InvalidVideoMetadata();
    offset = element.end;
  }
  if (!segment) return {};

  const values = new Map<string, string>();
  const budget = { totalBytes: 0 };
  offset = segment.dataStart;
  while (offset < segment.end) {
    if (++elementCount > MAX_ELEMENTS) throw new InvalidVideoMetadata();
    const child = await readEbmlElement(blob, offset, segment.end);
    if (child.unknownSize) throw new InvalidVideoMetadata();
    if (child.id === EBML_TAGS_ID) await parseWebmTags(blob, child, values, budget);
    offset = child.end;
  }
  return normalizeMetadataValues(values);
}

export async function readVideoMetadata(blob: Blob): Promise<Record<string, MetadataValue>> {
  try {
    const container = await detectVideoContainer(blob);
    if (container === 'mp4') return await parseMp4Metadata(blob);
    if (container === 'webm') return await parseWebmMetadata(blob);
  } catch {}
  return {};
}
