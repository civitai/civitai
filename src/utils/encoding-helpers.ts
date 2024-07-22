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
  return decoder.decode(littleEndianBuffer);
}
