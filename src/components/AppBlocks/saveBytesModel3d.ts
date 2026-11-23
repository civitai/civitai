/**
 * The 3D model types a `SAVE_IMAGE` `bytes` save accepts: binary glTF (`.glb`) and binary FBX
 * (`.fbx`). Pure, so the rules are unit-testable without the host. glTF-JSON, ASCII FBX and OBJ are
 * NOT accepted: they are text, so they would save as `.txt` (and a `.gltf` usually references
 * sibling files the save could not carry anyway).
 *
 * Two steps, the same split as the zip rules:
 *   1. {@link sniffSaveModel3dCandidate} — does the buffer START like one of these? Decided on the
 *      first 8 (GLB) or 21 (FBX) bytes, so the caller can pick the per-file cap before decoding.
 *      Both prefixes contain a NUL byte, so no text payload can ever be a candidate: refusing a
 *      candidate that fails step 2 takes nothing away from the text classifier, which refuses
 *      every NUL-bearing buffer anyway.
 *   2. {@link isValidSaveModel3d} — the strict structural check. A GLB must account for EVERY byte
 *      of the buffer in its declared chunks (nothing can ride along after it); an FBX must have a
 *      well-formed run of top-level node records ending in the null record, with no more than a
 *      footer's worth of bytes after it.
 */

/** The two 3D model types, each with the one extension it saves under. */
export const SAVE_BYTES_MODEL_3D_EXTENSION = {
  // IANA-registered.
  'model/gltf-binary': 'glb',
  // FBX has no registered media type; this names it for the Blob without claiming a registration.
  'model/x-fbx': 'fbx',
} as const;

export type SaveBytesModel3dType = keyof typeof SAVE_BYTES_MODEL_3D_EXTENSION;

/** `glTF` + container version 2 (little-endian u32). */
const GLB_PREFIX = [0x67, 0x6c, 0x54, 0x46, 0x02, 0x00, 0x00, 0x00] as const;
const GLB_HEADER_BYTES = 12;
const GLB_CHUNK_HEADER_BYTES = 8;
const GLB_CHUNK_JSON = 0x4e4f534a; // "JSON" read as a little-endian u32
const GLB_CHUNK_BIN = 0x004e4942; // "BIN\0" read as a little-endian u32

/** `Kaydara FBX Binary` + two spaces + NUL: the binary FBX magic. ASCII FBX starts with `; FBX`. */
const FBX_MAGIC = [
  0x4b, 0x61, 0x79, 0x64, 0x61, 0x72, 0x61, 0x20, 0x46, 0x42, 0x58, 0x20, 0x42, 0x69, 0x6e, 0x61,
  0x72, 0x79, 0x20, 0x20, 0x00,
] as const;
/** Magic, then `0x1A 0x00`, then the u32 version. */
const FBX_HEADER_BYTES = 27;
/** Binary FBX versions in use: 6100 (FBX 2006) through 7700 (FBX 2020). */
const FBX_MIN_VERSION = 6100;
const FBX_MAX_VERSION = 7999;
/** From 7500 a node record's three leading fields are u64 instead of u32. */
const FBX_WIDE_RECORD_VERSION = 7500;
/**
 * The most bytes allowed after the top-level null record. The footer writers emit is 160 bytes
 * plus up to 15 of alignment padding; 256 leaves room for a writer that differs, and still means
 * no second file of any size can follow the node data.
 */
export const FBX_MAX_TAIL_BYTES = 256;

function startsWith(u8: Uint8Array, sig: readonly number[]): boolean {
  if (u8.length < sig.length) return false;
  for (let i = 0; i < sig.length; i++) if (u8[i] !== sig[i]) return false;
  return true;
}

/** Which 3D type the buffer STARTS like, or `null`. Not a validation: see {@link isValidSaveModel3d}. */
export function sniffSaveModel3dCandidate(u8: Uint8Array): SaveBytesModel3dType | null {
  if (startsWith(u8, GLB_PREFIX)) return 'model/gltf-binary';
  if (startsWith(u8, FBX_MAGIC)) return 'model/x-fbx';
  return null;
}

/** Strict structural check of a candidate of `type`. */
export function isValidSaveModel3d(u8: Uint8Array, type: SaveBytesModel3dType): boolean {
  return type === 'model/gltf-binary' ? isValidGlb(u8) : isValidFbx(u8);
}

/**
 * glTF 2.0 binary container: a 12-byte header whose declared length equals the buffer's, then a
 * JSON chunk, then at most one BIN chunk, and nothing else. Every length is a multiple of 4 (the
 * spec's alignment rule), every chunk lies inside the declared length, and the chunks end exactly
 * at it. The JSON chunk must be UTF-8 that parses to an object carrying `asset.version`, the one
 * property glTF requires. Unknown chunk types are refused rather than skipped.
 */
function isValidGlb(u8: Uint8Array): boolean {
  if (u8.length < GLB_HEADER_BYTES + GLB_CHUNK_HEADER_BYTES) return false;
  if (!startsWith(u8, GLB_PREFIX)) return false;
  const view = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const length = view.getUint32(8, true);
  if (length !== u8.length || length % 4 !== 0) return false;

  let offset = GLB_HEADER_BYTES;
  let index = 0;
  while (offset < length) {
    if (index > 1 || length - offset < GLB_CHUNK_HEADER_BYTES) return false;
    const chunkLength = view.getUint32(offset, true);
    const chunkType = view.getUint32(offset + 4, true);
    const dataStart = offset + GLB_CHUNK_HEADER_BYTES;
    if (chunkLength % 4 !== 0 || chunkLength > length - dataStart) return false;
    if (index === 0) {
      if (chunkType !== GLB_CHUNK_JSON || chunkLength === 0) return false;
      if (!isGltfJson(u8.subarray(dataStart, dataStart + chunkLength))) return false;
    } else if (chunkType !== GLB_CHUNK_BIN) {
      return false;
    }
    offset = dataStart + chunkLength;
    index += 1;
  }
  return index >= 1 && offset === length;
}

function isGltfJson(bytes: Uint8Array): boolean {
  let doc: unknown;
  try {
    doc = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    return false;
  }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return false;
  const asset = (doc as { asset?: unknown }).asset;
  if (!asset || typeof asset !== 'object' || Array.isArray(asset)) return false;
  return typeof (asset as { version?: unknown }).version === 'string';
}

/**
 * Binary FBX: the magic, `0x1A 0x00`, a version in the range writers use, then a walk of the
 * TOP-LEVEL node records. Each record's end offset must lie at or past the end of its own header
 * and name (so the walk moves strictly forward) and stay inside the buffer, its name must be printable ASCII, and the walk must reach
 * the all-zero null record with at least one node before it. At most {@link FBX_MAX_TAIL_BYTES}
 * may follow the null record (the footer). Nested records are not walked: they lie inside a
 * top-level record's span, which the walk has already bounded.
 */
function isValidFbx(u8: Uint8Array): boolean {
  if (u8.length < FBX_HEADER_BYTES) return false;
  if (!startsWith(u8, FBX_MAGIC) || u8[21] !== 0x1a || u8[22] !== 0x00) return false;
  const view = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const version = view.getUint32(23, true);
  if (version < FBX_MIN_VERSION || version > FBX_MAX_VERSION) return false;
  const wide = version >= FBX_WIDE_RECORD_VERSION;
  const fieldBytes = wide ? 8 : 4;
  const recordHeaderBytes = fieldBytes * 3 + 1;
  const readField = (at: number): number =>
    wide ? Number(view.getBigUint64(at, true)) : view.getUint32(at, true);

  let offset = FBX_HEADER_BYTES;
  let nodes = 0;
  for (;;) {
    if (u8.length - offset < recordHeaderBytes) return false;
    const endOffset = readField(offset);
    const numProperties = readField(offset + fieldBytes);
    const propertyListLength = readField(offset + fieldBytes * 2);
    const nameLength = u8[offset + fieldBytes * 3];
    if (endOffset === 0) {
      // The null record: every field zero. Ends the top-level list.
      if (numProperties !== 0 || propertyListLength !== 0 || nameLength !== 0) return false;
      const tail = u8.length - (offset + recordHeaderBytes);
      return nodes > 0 && tail <= FBX_MAX_TAIL_BYTES;
    }
    const nameStart = offset + recordHeaderBytes;
    const bodyStart = nameStart + nameLength;
    // A node with no properties and no children ends right after its name; nameLength >= 1 keeps
    // every step strictly forward, so the walk terminates.
    if (nameLength === 0 || endOffset < bodyStart || endOffset > u8.length) return false;
    if (propertyListLength > endOffset - bodyStart) return false;
    for (let i = nameStart; i < bodyStart; i++) {
      if (u8[i] < 0x20 || u8[i] > 0x7e) return false;
    }
    offset = endOffset;
    nodes += 1;
  }
}
