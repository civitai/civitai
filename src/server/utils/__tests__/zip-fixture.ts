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
  /** Flags, method and extra field written in the local header in place of the directory's. */
  localFlags?: number;
  localMethod?: number;
  localExtra?: Buffer;
  /** Extra field written in the directory entry. */
  centralExtra?: Buffer;
  /** Bytes written after the entry's data (and its descriptor) that no header accounts for. */
  after?: Buffer;
  /**
   * `true` leaves the local header's checksum and sizes to a data descriptor after the data, as
   * torch writes them; a Buffer is written as the descriptor instead of the true one.
   */
  descriptor?: boolean | Buffer;
  /** Written as the local header's compressed size in place of the real one. */
  localCompressedSize?: number;
  /** Bytes appended to the compressed data and counted in its size, past where a deflate stream ends. */
  compressedTail?: Buffer;
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
    const body = Buffer.concat([
      methodCode === 8 ? deflateRawSync(data) : data,
      entry.compressedTail ?? Buffer.alloc(0),
    ]);
    const name = Buffer.from(entry.name, 'utf8');
    const localName = Buffer.from(entry.localName ?? entry.name, 'utf8');
    const flags = (entry.flags ?? 0) | (entry.descriptor ? 0x08 : 0);
    const size = entry.declaredSize ?? data.byteLength;
    const compressedSize = entry.declaredCompressedSize ?? body.byteLength;
    const crc = crc32(data);
    const header = Buffer.concat([
      u32(0x04034b50),
      u16(20),
      u16(entry.localFlags ?? flags),
      u16(entry.localMethod ?? methodCode),
      u16(0),
      u16(0x21),
      u32(entry.descriptor ? 0 : crc),
      u32(entry.localCompressedSize ?? (entry.descriptor ? 0 : compressedSize)),
      u32(entry.descriptor ? 0 : size),
      u16(localName.byteLength),
      u16(entry.localExtra?.byteLength ?? 0),
      localName,
      entry.localExtra ?? Buffer.alloc(0),
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
        u16(entry.centralExtra?.byteLength ?? 0),
        u16(0),
        u16(0),
        u16(0),
        u32(entry.externalAttributes ?? 0),
        u32(offset),
        name,
        entry.centralExtra ?? Buffer.alloc(0),
      ])
    );
    const descriptor = Buffer.isBuffer(entry.descriptor)
      ? entry.descriptor
      : entry.descriptor
      ? Buffer.concat([u32(0x08074b50), u32(crc), u32(compressedSize), u32(size)])
      : Buffer.alloc(0);
    const after = Buffer.concat([descriptor, entry.after ?? Buffer.alloc(0)]);
    local.push(header, body, after);
    offset += header.byteLength + body.byteLength + after.byteLength;
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
export const symlinkAttributes = () => (0o120777 << 16) >>> 0;
