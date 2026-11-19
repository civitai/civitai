import { crc32, deflateRawSync } from 'zlib';

/**
 * A zip writer for tests, with every header field under the caller's control: a real archive can be
 * built that lies about its sizes, sets the encryption flag, carries a symlink's attributes, or has
 * a path no sane tool would write. Nothing here is used outside tests.
 */
export type FixtureEntry = {
  name: string;
  data?: Buffer;
  /** Default: deflate. */
  method?: 'store' | 'deflate' | number;
  /** Written as the entry's general-purpose flags (bit 0 is "encrypted"). */
  flags?: number;
  /** Written as the entry's external attributes; a unix mode goes in the top 16 bits. */
  externalAttributes?: number;
  /** Written in the headers in place of the real uncompressed size. */
  declaredSize?: number;
  /** Written in the headers in place of the real compressed size. */
  declaredCompressedSize?: number;
  /** Name written in the local header; differs from the directory name. */
  localName?: string;
};

export type FixtureOptions = {
  /** Entry count recorded in the archive's end record. */
  declaredEntryCount?: number;
  /** Bytes appended after the archive's end record. */
  trailing?: Buffer;
};

const u16 = (n: number) => {
  const b = Buffer.alloc(2);
  b.writeUInt16LE(n);
  return b;
};
const u32 = (n: number) => {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n >>> 0);
  return b;
};

export function buildZip(entries: FixtureEntry[], options: FixtureOptions = {}) {
  const local: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const data = entry.data ?? Buffer.alloc(0);
    const method = entry.method ?? 'deflate';
    const methodCode = method === 'store' ? 0 : method === 'deflate' ? 8 : method;
    const body = methodCode === 8 ? deflateRawSync(data) : data;
    const name = Buffer.from(entry.name, 'utf8');
    const localName = Buffer.from(entry.localName ?? entry.name, 'utf8');
    const flags = entry.flags ?? 0;
    const size = entry.declaredSize ?? data.byteLength;
    const compressedSize = entry.declaredCompressedSize ?? body.byteLength;
    const crc = crc32(data);
    const header = Buffer.concat([
      u32(0x04034b50),
      u16(20),
      u16(flags),
      u16(methodCode),
      u16(0),
      u16(0x21),
      u32(crc),
      u32(compressedSize),
      u32(size),
      u16(localName.byteLength),
      u16(0),
      localName,
    ]);
    central.push(
      Buffer.concat([
        u32(0x02014b50),
        // Made on unix, so the attributes' top bits are a mode.
        u16((3 << 8) | 20),
        u16(20),
        u16(flags),
        u16(methodCode),
        u16(0),
        u16(0x21),
        u32(crc),
        u32(compressedSize),
        u32(size),
        u16(name.byteLength),
        u16(0),
        u16(0),
        u16(0),
        u16(0),
        u32(entry.externalAttributes ?? 0),
        u32(offset),
        name,
      ])
    );
    local.push(header, body);
    offset += header.byteLength + body.byteLength;
  }
  const directory = Buffer.concat(central);
  return Buffer.concat([
    ...local,
    directory,
    u32(0x06054b50),
    u16(0),
    u16(0),
    u16(options.declaredEntryCount ?? entries.length),
    u16(options.declaredEntryCount ?? entries.length),
    u32(directory.byteLength),
    u32(offset),
    u16(0),
    options.trailing ?? Buffer.alloc(0),
  ]);
}

/** The smallest buffer the zip reader takes for a PNG. It is not decodable; the reader only sniffs. */
export const PNG_BYTES = (extra = 32) =>
  Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.alloc(extra, 7),
  ]);
export const JPEG_BYTES = (extra = 32) =>
  Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(extra, 7)]);
export const MP4_BYTES = () =>
  Buffer.concat([Buffer.from([0, 0, 0, 0x20]), Buffer.from('ftypisom'), Buffer.alloc(32)]);
const box = (type: string, ...parts: Buffer[]) => {
  const body = Buffer.concat(parts);
  const size = Buffer.alloc(4);
  size.writeUInt32BE(body.length + 8);
  return Buffer.concat([size, Buffer.from(type, 'latin1'), body]);
};
const words = (...values: number[]) => {
  const out = Buffer.alloc(values.length * 4);
  values.forEach((value, i) => out.writeUInt32BE(value, i * 4));
  return out;
};
/**
 * A playable-shaped mp4: one track whose sample table spans `seconds`, and whose headers (mvhd,
 * tkhd, mdhd) claim `headerSeconds`. Timescale 1000.
 */
export const mp4Clip = ({
  seconds = 10,
  headerSeconds = seconds,
}: { seconds?: number; headerSeconds?: number } = {}) => {
  const claimed = Math.round(headerSeconds * 1000);
  return Buffer.concat([
    box('ftyp', Buffer.from('isom', 'latin1'), words(0x200), Buffer.from('isomiso2mp41', 'latin1')),
    box(
      'moov',
      box('mvhd', words(0, 0, 0, 1000, claimed), Buffer.alloc(80)),
      box(
        'trak',
        box('tkhd', words(0, 0, 0, 1, 0, claimed), Buffer.alloc(60)),
        box(
          'mdia',
          box('mdhd', words(0, 0, 0, 1000, claimed, 0)),
          box(
            'minf',
            box(
              'stbl',
              box('stts', words(0, 1, 1, Math.round(seconds * 1000))),
              box('stsz', words(0, 4, 1))
            )
          )
        )
      )
    ),
    box('mdat', Buffer.alloc(4)),
  ]);
};
export { box as mp4Box, words as mp4Words };

const ebmlSize = (n: number | 'unknown') => {
  const out = Buffer.alloc(8);
  if (n === 'unknown') out.fill(0xff);
  else out.writeBigUInt64BE(BigInt(n));
  out[0] = 0x01;
  return out;
};
export const ebml = (id: number, body: Buffer | 'none', size?: 'unknown') => {
  const hex = id.toString(16);
  const idBytes = Buffer.from(hex.length % 2 ? `0${hex}` : hex, 'hex');
  const content = body === 'none' ? Buffer.alloc(0) : body;
  return Buffer.concat([idBytes, ebmlSize(size ?? content.length), content]);
};
/**
 * A webm whose Info claims `declared` seconds (none when undefined) and whose clusters hold one
 * block at each of `blocks` (seconds). Clusters are of unknown size when `unknownSize`.
 */
export const webmClip = ({
  declared,
  blocks = [0, 10],
  unknownSize = false,
}: { declared?: number; blocks?: number[]; unknownSize?: boolean } = {}) => {
  const f64 = Buffer.alloc(8);
  if (declared !== undefined) f64.writeDoubleBE(declared * 1000);
  const info = ebml(
    0x1549a966,
    Buffer.concat([
      ebml(0x2ad7b1, Buffer.from([0x0f, 0x42, 0x40])),
      ...(declared !== undefined ? [ebml(0x4489, f64)] : []),
    ])
  );
  const clusters = blocks.map((at) => {
    const ms = Math.round(at * 1000);
    const tc = Buffer.alloc(4);
    tc.writeUInt32BE(ms);
    const body = Buffer.concat([
      ebml(0xe7, tc),
      ebml(0xa3, Buffer.from([0x81, 0x00, 0x00, 0x80, 0x00])),
    ]);
    return unknownSize
      ? Buffer.concat([ebml(0x1f43b675, 'none', 'unknown'), body])
      : ebml(0x1f43b675, body);
  });
  return Buffer.concat([
    ebml(0x1a45dfa3, ebml(0x4282, Buffer.from('webm'))),
    ebml(0x18538067, Buffer.concat([info, ...clusters]), unknownSize ? 'unknown' : undefined),
  ]);
};
export const symlinkAttributes = () => (0o120777 << 16) >>> 0;
