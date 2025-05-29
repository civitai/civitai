/**
 * Swap the byte order of a Uint8Array from big-endian to little-endian.
 * @param buffer - The input Uint8Array with big-endian byte order.
 * @returns A new Uint8Array with little-endian byte order.
 */
export function swapByteOrder(buffer: Uint8Array): Uint8Array {
  const swapped = new Uint8Array(buffer.length);
  for (let i = 0; i < buffer.length; i += 2) {
    swapped[i] = buffer[i + 1];
    swapped[i + 1] = buffer[i];
  }
  return swapped;
}

/**
 * Remove Unicode header bytes if present.
 * @param buffer - The input Uint8Array.
 * @returns A new Uint8Array without BOM or header bytes.
 */
const unicodeHeader = new Uint8Array([85, 78, 73, 67, 79, 68, 69, 0]);
export function removeUnicodeHeader(buffer: Uint8Array): Uint8Array {
  if (buffer.length < unicodeHeader.length) return buffer;

  // Check for BOM (Byte Order Mark) for big-endian UTF-16 (0xFEFF) and remove it if present
  for (let i = 0; i < unicodeHeader.length; i++) {
    if (buffer[i] !== unicodeHeader[i]) return buffer;
  }
  return buffer.slice(unicodeHeader.length);
}

/**
 * Decode a big-endian UTF-16 (Unicode) encoded buffer to a string.
 * @param buffer - The input Uint8Array with big-endian byte order.
 * @returns The decoded string.
 */
const decoder = new TextDecoder('utf-16le');
export function decodeBigEndianUTF16(buffer: Uint8Array): string {
  // Remove BOM or unwanted header bytes if present
  const bufferWithoutBOM = removeUnicodeHeader(buffer);
  // Swap the byte order from big-endian to little-endian
  const littleEndianBuffer = swapByteOrder(bufferWithoutBOM);
  // Use TextDecoder to decode the little-endian buffer
  const result = decoder.decode(littleEndianBuffer);

  return result;
}

export function createExifSegmentWithUserComment(userCommentBytes: number[]) {
  const exifHeader = [
    0x45,
    0x78,
    0x69,
    0x66,
    0x00,
    0x00, // "Exif\0\0"
  ];

  const tiffHeader = [
    0x49,
    0x49, // Little endian "II"
    0x2a,
    0x00, // TIFF marker
    0x08,
    0x00,
    0x00,
    0x00, // Offset to 1st IFD (always 8)
  ];

  const numEntries = 1;
  const tag = 0x9286; // UserComment
  const type = 7; // UNDEFINED
  const count = userCommentBytes.length;

  const tagEntry = [
    tag & 0xff,
    tag >> 8, // tag ID (little endian)
    type,
    0x00, // type = 7 (UNDEFINED)
    count & 0xff,
    (count >> 8) & 0xff,
    (count >> 16) & 0xff,
    (count >> 24) & 0xff,
    0x1a,
    0x00,
    0x00,
    0x00, // Offset to value (past IFD)
  ];

  const ifd = [
    numEntries,
    0x00,
    ...tagEntry,
    0x00,
    0x00,
    0x00,
    0x00, // Next IFD offset = 0
  ];

  const exifBytes = [...exifHeader, ...tiffHeader, ...ifd, ...userCommentBytes];

  // Wrap in APP1 EXIF marker
  const length = exifBytes.length + 2;
  return [
    0xff,
    0xe1, // APP1 marker
    (length >> 8) & 0xff,
    length & 0xff,
    ...exifBytes,
  ];
}

const prefix = [0x55, 0x4e, 0x49, 0x43, 0x4f, 0x44, 0x45, 0x00]; // UNICODE\0
export function encodeUserCommentUTF16LE(str: string) {
  const encoded = [];
  for (let i = 0; i < str.length; i++) {
    const code = str.charCodeAt(i);
    encoded.push(code & 0xff); // low byte
    encoded.push((code >> 8) & 0xff); // high byte
  }
  return prefix.concat(encoded);
}

export function encodeUserCommentUTF16BE(str: string) {
  const encoded = [];
  for (let i = 0; i < str.length; i++) {
    const code = str.charCodeAt(i);
    encoded.push((code >> 8) & 0xff); // high byte
    encoded.push(code & 0xff); // low byte
  }

  return prefix.concat(encoded);
}
