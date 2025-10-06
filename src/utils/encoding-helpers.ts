import { isDefined } from '~/utils/type-guards';

/**
 * Swap the byte order of a Uint8Array from big-endian to little-endian.
 * @param buffer - The input Uint8Array with big-endian byte order.
 * @returns A new Uint8Array with little-endian byte order.
 */
// function swapByteOrder(buffer: Uint8Array): Uint8Array {
//   const swapped = new Uint8Array(buffer.length);
//   for (let i = 0; i < buffer.length; i += 2) {
//     swapped[i] = buffer[i + 1];
//     swapped[i + 1] = buffer[i];
//   }
//   return swapped;
// }

/**
 * Remove Unicode header bytes if present.
 * @param buffer - The input Uint8Array.
 * @returns A new Uint8Array without BOM or header bytes.
 */
// const unicodeHeader = new Uint8Array([85, 78, 73, 67, 79, 68, 69, 0]);
// function removeUnicodeHeader(buffer: Uint8Array): Uint8Array {
//   if (buffer.length < unicodeHeader.length) return buffer;

//   // Check for BOM (Byte Order Mark) for big-endian UTF-16 (0xFEFF) and remove it if present
//   for (let i = 0; i < unicodeHeader.length; i++) {
//     if (buffer[i] !== unicodeHeader[i]) return buffer;
//   }
//   return buffer.slice(unicodeHeader.length);
// }

/**
 * Decode a big-endian UTF-16 (Unicode) encoded buffer to a string.
 * @param buffer - The input Uint8Array with big-endian byte order.
 * @returns The decoded string.
 */
// const decoder = new TextDecoder('utf-16le');
// export function decodeUserCommentBE(buffer: Uint8Array): string {
//   // Remove BOM or unwanted header bytes if present
//   const bufferWithoutBOM = removeUnicodeHeader(buffer);
//   // Swap the byte order from big-endian to little-endian
//   const littleEndianBuffer = swapByteOrder(bufferWithoutBOM);
//   // Use TextDecoder to decode the little-endian buffer
//   const result = decoder.decode(littleEndianBuffer);

//   return result;
// }

export function decodeUTF32LE(buffer: Uint8Array): string {
  let result = '';
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);

  for (let i = 0; i + 3 < buffer.byteLength; i += 4) {
    const codePoint = view.getUint32(i, true); // little-endian
    if (codePoint === 0) continue; // skip nulls/padding
    result += String.fromCodePoint(codePoint);
  }

  return result;
}

export function decodeUserComment(buffer: Uint8Array): string {
  if (buffer.length < 8) return '';

  const header = new TextDecoder('ascii').decode(buffer.subarray(0, 8));
  const content = buffer.subarray(8); // skip the "UNICODE\0" header

  if (header.startsWith('ASCII')) return new TextDecoder('ascii').decode(content);
  if (header.startsWith('UTF8')) return new TextDecoder('utf-8').decode(content);

  // For UNICODE header (old and new images), decode as UTF-32LE
  return decodeUTF32LE(content);
}

const prefix = [0x55, 0x4e, 0x49, 0x43, 0x4f, 0x44, 0x45, 0x00]; // UNICODE\0
// function encodeUserCommentUTF16LE(str: string) {
//   const encoded = [];
//   for (let i = 0; i < str.length; i++) {
//     const code = str.charCodeAt(i);
//     encoded.push(code & 0xff); // low byte
//     encoded.push((code >> 8) & 0xff); // high byte
//   }
//   return new Uint8Array(prefix.concat(encoded));
// }

export function encodeUserCommentUTF16BE(str: string) {
  const encoded = [];
  for (let i = 0; i < str.length; i++) {
    const code = str.charCodeAt(i);
    encoded.push((code >> 8) & 0xff); // high byte
    encoded.push(code & 0xff); // low byte
  }

  return new Uint8Array(prefix.concat(encoded));
}

const u16le = (v: number) => [v & 0xff, (v >> 8) & 0xff];
const u32le = (v: number) => [v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >> 24) & 0xff];

function makeIFDEntryLE(
  tag: number,
  type: number,
  count: number,
  valueOrOffset: Uint8Array | number
) {
  // prettier-ignore
  const entry = [
    ...u16le(tag),      // Tag
    ...u16le(type),     // Type
    ...u32le(count),    // Count
  ];

  if (valueOrOffset instanceof Uint8Array) {
    const valueBytes = new Uint8Array(4).fill(0);
    valueBytes.set(valueOrOffset.slice(0, 4)); // inline data (padded/truncated to 4 bytes)
    entry.push(...valueBytes);
  } else {
    entry.push(...u32le(valueOrOffset)); // offset into data section
  }

  return entry;
}

function asciiEncoder(value: string | string[]) {
  const str = Array.isArray(value) ? value.join(', ') : value;
  return new TextEncoder().encode(str + '\0');
}

const tagMap = {
  artist: {
    tag: 0x013b,
    type: 2,
    encoder: asciiEncoder,
  }, // ASCII
  userComment: {
    tag: 0x9286,
    type: 7,
    encoder: (value: Uint32Array | Uint8Array) => {
      if (value instanceof Uint32Array) return new Uint8Array(value.buffer);
      else if (value instanceof Uint8Array) return value;
      return encodeUserCommentUTF16BE(value as string);
    },
  },
  software: {
    tag: 0x0131,
    type: 2,
    encoder: asciiEncoder,
  },
};

export function isEncoded(value: any) {
  return value instanceof Uint8Array || value instanceof Uint32Array;
}

// some good info can be found here: https://getaround.tech/exif-data-manipulation-javascript/
export function createExifSegmentFromTags(args: {
  artist?: string | string[];
  userComment?: Uint32Array | Uint8Array;
  software?: string | string[];
}) {
  const tagsArray = Object.entries(args)
    .map(([key, value]) => {
      const tagMapMatch = tagMap[key as keyof typeof tagMap];
      if (!tagMapMatch || !value) return null;
      return { key, value, ...tagMapMatch };
    })
    .filter(isDefined)
    .sort((a, b) => a.tag - b.tag);

  const valueBlocks: { tag: number; type: number; count: number; data: Uint8Array }[] = [];

  for (const { value, tag, type, encoder } of tagsArray) {
    const data = encoder(value as any);
    valueBlocks.push({ tag, type, count: data.length, data });
  }

  // prettier-ignore
  const tiffHeader = [
    0x49, 0x49,       // Byte order: "II" = little endian
    0x2A, 0x00,       // TIFF magic number (42)
    0x08, 0x00, 0x00, 0x00  // Offset to first IFD
  ];

  const entryCount = valueBlocks.length;
  const idfBlockSize = u16le(entryCount); // [entryCount, 00]
  const nextIFDBlockOffset = u32le(0); // [00, 00, 00, 00]

  const tiffHeaderSize = tiffHeader.length; // 8
  const entryCountSize = idfBlockSize.length; // 2
  const nextIFDOffsetSize = nextIFDBlockOffset.length; // 4

  const dataStart = tiffHeaderSize + entryCountSize + entryCount * 12 + nextIFDOffsetSize;

  let offset = dataStart;
  const entryBytes: number[][] = [];
  const dataBytes: Uint8Array[] = [];

  for (const block of valueBlocks) {
    const isInline = block.type === 2 && block.count <= 4;
    if (isInline) {
      entryBytes.push(makeIFDEntryLE(block.tag, block.type, block.count, block.data));
    } else {
      entryBytes.push(makeIFDEntryLE(block.tag, block.type, block.count, offset));
      dataBytes.push(block.data);
      offset += block.data.length;
    }
  }

  const ifdBlock = [...idfBlockSize, ...entryBytes.flat(), ...nextIFDBlockOffset];

  // prettier-ignore
  const exifHeader  = new Uint8Array([
    0x45, 0x78, 0x69, 0x66, 0x00, 0x00, // "Exif\0\0"
    ...tiffHeader,
    ...ifdBlock,
    ...dataBytes.flatMap((x) => [...x]),
  ]);

  const segmentLength = exifHeader.length + 2;
  // prettier-ignore
  const exifSegment = new Uint8Array([
    0xFF, 0xE1,                            // APP1 marker
    (segmentLength >> 8) & 0xFF, segmentLength & 0xFF,
    ...exifHeader
  ]);

  return exifSegment;
}
