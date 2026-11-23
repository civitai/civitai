/**
 * Minimal, spec-shaped binary glTF and FBX buffers for the SAVE_IMAGE `bytes` tests, built here so
 * a test can size them (the cap cases) and break one field at a time (the spoof cases). The real,
 * tool-written files beside them are `fixtures/tri.glb` and `fixtures/tri.fbx` (assimp 6 export of
 * a one-triangle OBJ); the unit test checks both builders against the same rules those pass.
 */

const enc = new TextEncoder();

function u32(n: number): number[] {
  return [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff];
}

function u64(n: number): number[] {
  return [...u32(n % 2 ** 32), ...u32(Math.floor(n / 2 ** 32))];
}

/** Pad to a multiple of 4 with `fill` (spaces for the JSON chunk, zeros for BIN). */
function pad4(bytes: Uint8Array, fill: number): Uint8Array {
  const len = Math.ceil(bytes.length / 4) * 4;
  const out = new Uint8Array(len).fill(fill);
  out.set(bytes);
  return out;
}

/**
 * A GLB: header, a JSON chunk (`json`, space-padded), then a zero-filled BIN chunk of `binBytes`
 * (rounded up to 4; omitted when 0). `totalBytes`, when given, sizes the BIN chunk so the whole
 * file is exactly that long (must be a multiple of 4 and leave room for the JSON chunk).
 */
export function buildGlb({
  json = { asset: { version: '2.0' } } as unknown,
  binBytes = 0,
  totalBytes,
}: { json?: unknown; binBytes?: number; totalBytes?: number } = {}): Uint8Array {
  const jsonChunk = pad4(enc.encode(JSON.stringify(json)), 0x20);
  const jsonPart = 12 + 8 + jsonChunk.length;
  let bin = binBytes;
  if (totalBytes !== undefined) {
    if (totalBytes % 4 !== 0 || totalBytes < jsonPart + 8) throw new Error('bad totalBytes');
    bin = totalBytes - jsonPart - 8;
  }
  bin = Math.ceil(bin / 4) * 4;
  const length = jsonPart + (bin > 0 || totalBytes !== undefined ? 8 + bin : 0);
  const out = new Uint8Array(length);
  out.set([0x67, 0x6c, 0x54, 0x46, ...u32(2), ...u32(length)], 0);
  out.set([...u32(jsonChunk.length), 0x4a, 0x53, 0x4f, 0x4e], 12);
  out.set(jsonChunk, 20);
  if (length > jsonPart) out.set([...u32(bin), 0x42, 0x49, 0x4e, 0x00], jsonPart);
  return out;
}

/** Overwrite the u32 at `offset` (little-endian) in a copy of `u8`. */
export function withU32(u8: Uint8Array, offset: number, value: number): Uint8Array {
  const out = u8.slice();
  new DataView(out.buffer).setUint32(offset, value, true);
  return out;
}

export const FBX_MAGIC = enc.encode('Kaydara FBX Binary  \0');

/** The footer FBX writers emit after the top-level null record: 160 bytes ending in its magic. */
const FBX_FOOTER = (() => {
  const out = new Uint8Array(160);
  out.set(
    [
      0xf8, 0x5a, 0x8c, 0x6a, 0xde, 0xf5, 0xd9, 0x7e, 0xec, 0xe9, 0x0c, 0xe3, 0x75, 0x8f, 0x29,
      0x0b,
    ],
    144
  );
  return out;
})();

/**
 * A binary FBX of `version`: the header, one top-level node per name (no properties, `bodyBytes`
 * zero bytes of nested data each), the null record, then the 160-byte footer (`tail` overrides it).
 */
export function buildFbx({
  version = 7500,
  names = ['FBXHeaderExtension', 'Objects'],
  bodyBytes = 0,
  tail = FBX_FOOTER,
}: {
  version?: number;
  names?: string[];
  bodyBytes?: number;
  tail?: Uint8Array;
} = {}): Uint8Array {
  const wide = version >= 7500;
  const field = wide ? u64 : u32;
  const headerBytes = wide ? 25 : 13;
  const parts: number[] = [...FBX_MAGIC, 0x1a, 0x00, ...u32(version)];
  for (const name of names) {
    const nameBytes = [...enc.encode(name)];
    const end = parts.length + headerBytes + nameBytes.length + bodyBytes;
    parts.push(...field(end), ...field(0), ...field(0), nameBytes.length, ...nameBytes);
    for (let i = 0; i < bodyBytes; i++) parts.push(0);
  }
  parts.push(...new Array<number>(headerBytes).fill(0));
  const out = new Uint8Array(parts.length + tail.length);
  out.set(parts);
  out.set(tail, parts.length);
  return out;
}

/**
 * A large binary FBX of exactly `totalBytes`: one top-level node whose nested data fills the space.
 * Built directly into one buffer, so a 100 MB case does not go through a JS number array.
 */
export function buildLargeFbx(totalBytes: number): Uint8Array {
  const name = enc.encode('Objects');
  const headStart = 27;
  const headerBytes = 25;
  const fixed = headStart + headerBytes + name.length + headerBytes + FBX_FOOTER.length;
  if (totalBytes < fixed) throw new Error('bad totalBytes');
  const out = new Uint8Array(totalBytes);
  out.set(FBX_MAGIC, 0);
  out.set([0x1a, 0x00, ...u32(7500)], 21);
  const end = totalBytes - headerBytes - FBX_FOOTER.length;
  out.set([...u64(end), ...u64(0), ...u64(0), name.length], headStart);
  out.set(name, headStart + headerBytes);
  out.set(FBX_FOOTER, totalBytes - FBX_FOOTER.length);
  return out;
}

/** Concatenate buffers. */
export function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** A standalone ArrayBuffer holding exactly `u8`'s bytes. */
export const ab = (u8: Uint8Array): ArrayBuffer => u8.slice().buffer;
