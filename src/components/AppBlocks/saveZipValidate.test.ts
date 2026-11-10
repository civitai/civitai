import { deflateRawSync } from 'node:zlib';
import JSZip from 'jszip';
import { describe, expect, it } from 'vitest';
import {
  classifySaveBytes,
  classifySaveBytesContent,
  prepareSaveBytes,
  processSaveBytes,
  SAVE_BYTES_MAX_BYTES,
  SAVE_BYTES_MAX_PER_WINDOW,
  SAVE_BYTES_ZIP_MAX_BYTES,
  SAVE_BYTES_ZIP_MAX_BYTES_PER_WINDOW,
  verifySaveBytesContent,
  type PreparedSaveBytes,
} from './saveImageDownload';
import {
  SAVE_ZIP64_ERROR,
  SAVE_ZIP_ABSOLUTE_PATH_ERROR,
  SAVE_ZIP_ALTERNATE_PATH_ERROR,
  SAVE_ZIP_BACKSLASH_ERROR,
  SAVE_ZIP_CENTRAL_DIRECTORY_ERROR,
  SAVE_ZIP_CONTROL_CHAR_ERROR,
  SAVE_ZIP_DATA_DESCRIPTOR_ERROR,
  SAVE_ZIP_DIRECTORY_DATA_ERROR,
  SAVE_ZIP_DRIVE_OR_COLON_ERROR,
  SAVE_ZIP_DUPLICATE_NAME_ERROR,
  SAVE_ZIP_EMPTY_ERROR,
  SAVE_ZIP_EMPTY_SEGMENT_ERROR,
  SAVE_ZIP_ENCRYPTED_ERROR,
  SAVE_ZIP_EXTRA_FIELD_ERROR,
  SAVE_ZIP_FLAGS_ERROR,
  SAVE_ZIP_HEADER_MISMATCH_ERROR,
  SAVE_ZIP_INFLATE_ERROR,
  SAVE_ZIP_LAYOUT_ERROR,
  SAVE_ZIP_LIMITS,
  SAVE_ZIP_LOCAL_HEADER_ERROR,
  SAVE_ZIP_MAX_BYTES,
  SAVE_ZIP_MULTIDISK_ERROR,
  SAVE_ZIP_NAME_ENCODING_ERROR,
  SAVE_ZIP_NO_EOCD_ERROR,
  SAVE_ZIP_PATH_CONFLICT_ERROR,
  SAVE_ZIP_RATIO_ERROR,
  SAVE_ZIP_SPECIAL_FILE_ERROR,
  SAVE_ZIP_STORED_SIZE_ERROR,
  SAVE_ZIP_TOO_MANY_ENTRIES_ERROR,
  SAVE_ZIP_TOTAL_SIZE_ERROR,
  SAVE_ZIP_TRAVERSAL_ERROR,
  SAVE_ZIP_TRUNCATED_ERROR,
  saveZipEntryTypeError,
  saveZipMethodError,
  validateSaveZip,
  type SaveZipDeflatedEntry,
} from './saveZipValidate';

// ── Fixtures ────────────────────────────────────────────────────────────────────────────────────
//
// Two sources, on purpose: REAL zips written by jszip (what an app author's code produces), and a
// raw byte-level builder for the malicious shapes jszip will not write. The builder's own baseline
// is asserted VALID first (positive control), so every refusal below is a refusal of the one field
// the case changes, not of a builder bug.

const MB = 1024 * 1024;
const enc = new TextEncoder();
const bytesOf = (s: string | Uint8Array) => (typeof s === 'string' ? enc.encode(s) : s);
// A real PNG signature + IHDR start, so a sniffer that only checks length can't pass.
const PNG_HEAD = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49];

type Raw = {
  name: string | Uint8Array;
  localName?: string | Uint8Array;
  /** The bytes written as the entry's (compressed) data. */
  data?: Uint8Array;
  method?: number;
  localMethod?: number;
  flags?: number;
  localFlags?: number;
  crc?: number;
  /** Declared uncompressed size (central directory). Defaults to data.length. */
  size?: number;
  /** Declared compressed size (central directory). Defaults to data.length. */
  compressedSize?: number;
  /** Local-header crc / sizes; default = the central values (zeros when a descriptor is used). */
  local?: { crc?: number; compressedSize?: number; size?: number };
  descriptor?: 'sig' | 'nosig';
  /** The 4-byte value written where a 'sig' descriptor's signature goes. */
  descriptorSig?: number;
  /** The central record's "disk number start". */
  diskStart?: number;
  descriptorValues?: { crc: number; compressedSize: number; size: number };
  extra?: Uint8Array;
  localExtra?: Uint8Array;
  externalAttrs?: number;
  /** Override the central directory's recorded local-header offset. */
  localOffset?: number;
  /** Bytes written after this entry's data (before the next local header). */
  after?: Uint8Array;
};

type Opts = {
  prefix?: Uint8Array;
  beforeCd?: Uint8Array;
  trailing?: Uint8Array;
  comment?: Uint8Array;
  beforeEocd?: Uint8Array;
  eocd?: Partial<{
    disk: number;
    cdDisk: number;
    entriesOnDisk: number;
    totalEntries: number;
    cdSize: number;
    cdOffset: number;
    /** The comment length the EOCD DECLARES (default: the real comment's). */
    commentLen: number;
  }>;
};

class W {
  private parts: Uint8Array[] = [];
  length = 0;
  bytes(b: Uint8Array) {
    this.parts.push(b);
    this.length += b.length;
  }
  u16(v: number) {
    const b = new Uint8Array(2);
    new DataView(b.buffer).setUint16(0, v, true);
    this.bytes(b);
  }
  u32(v: number) {
    const b = new Uint8Array(4);
    new DataView(b.buffer).setUint32(0, v >>> 0, true);
    this.bytes(b);
  }
  out(): ArrayBuffer {
    const u8 = new Uint8Array(this.length);
    let o = 0;
    for (const p of this.parts) {
      u8.set(p, o);
      o += p.length;
    }
    return u8.buffer;
  }
}

function buildZip(entries: Raw[], opts: Opts = {}): ArrayBuffer {
  const w = new W();
  if (opts.prefix) w.bytes(opts.prefix);
  const offsets: number[] = [];
  for (const e of entries) {
    const data = e.data ?? new Uint8Array(0);
    const name = bytesOf(e.name);
    const localName = e.localName != null ? bytesOf(e.localName) : name;
    const flags = e.flags ?? (e.descriptor ? 1 << 3 : 0);
    const crc = e.crc ?? 0x1234abcd;
    const csize = e.compressedSize ?? data.length;
    const usize = e.size ?? data.length;
    const zeroLocal = e.descriptor != null;
    const localExtra = e.localExtra ?? new Uint8Array(0);
    offsets.push(w.length);
    w.u32(0x04034b50);
    w.u16(20);
    w.u16(e.localFlags ?? flags);
    w.u16(e.localMethod ?? e.method ?? 0);
    w.u16(0);
    w.u16(0x21);
    w.u32(e.local?.crc ?? (zeroLocal ? 0 : crc));
    w.u32(e.local?.compressedSize ?? (zeroLocal ? 0 : csize));
    w.u32(e.local?.size ?? (zeroLocal ? 0 : usize));
    w.u16(localName.length);
    w.u16(localExtra.length);
    w.bytes(localName);
    w.bytes(localExtra);
    w.bytes(data);
    if (e.descriptor) {
      const d = e.descriptorValues ?? { crc, compressedSize: csize, size: usize };
      if (e.descriptor === 'sig') w.u32(e.descriptorSig ?? 0x08074b50);
      w.u32(d.crc);
      w.u32(d.compressedSize);
      w.u32(d.size);
    }
    if (e.after) w.bytes(e.after);
  }
  if (opts.beforeCd) w.bytes(opts.beforeCd);
  const cdOffset = w.length;
  entries.forEach((e, i) => {
    const data = e.data ?? new Uint8Array(0);
    const name = bytesOf(e.name);
    const extra = e.extra ?? new Uint8Array(0);
    w.u32(0x02014b50);
    w.u16(20);
    w.u16(20);
    w.u16(e.flags ?? (e.descriptor ? 1 << 3 : 0));
    w.u16(e.method ?? 0);
    w.u16(0);
    w.u16(0x21);
    w.u32(e.crc ?? 0x1234abcd);
    w.u32(e.compressedSize ?? data.length);
    w.u32(e.size ?? data.length);
    w.u16(name.length);
    w.u16(extra.length);
    w.u16(0);
    w.u16(e.diskStart ?? 0);
    w.u16(0);
    w.u32(e.externalAttrs ?? 0);
    w.u32(e.localOffset ?? offsets[i]);
    w.bytes(name);
    w.bytes(extra);
  });
  const cdSize = w.length - cdOffset;
  if (opts.beforeEocd) w.bytes(opts.beforeEocd);
  const comment = opts.comment ?? new Uint8Array(0);
  w.u32(0x06054b50);
  w.u16(opts.eocd?.disk ?? 0);
  w.u16(opts.eocd?.cdDisk ?? 0);
  w.u16(opts.eocd?.entriesOnDisk ?? entries.length);
  w.u16(opts.eocd?.totalEntries ?? entries.length);
  w.u32(opts.eocd?.cdSize ?? cdSize);
  w.u32(opts.eocd?.cdOffset ?? cdOffset);
  w.u16(opts.eocd?.commentLen ?? comment.length);
  w.bytes(comment);
  if (opts.trailing) w.bytes(opts.trailing);
  return w.out();
}

const extraField = (id: number, body: number[] = [0, 0, 0, 0]) => {
  const u8 = new Uint8Array(4 + body.length);
  const v = new DataView(u8.buffer);
  v.setUint16(0, id, true);
  v.setUint16(2, body.length, true);
  u8.set(body, 4);
  return u8;
};

const file = (name: string, content = 'caption text') => ({ name, data: enc.encode(content) });
const deflated = (name: string, content: Uint8Array) => {
  const data = new Uint8Array(deflateRawSync(content));
  return { name, method: 8, data, size: content.length };
};

/** A valid single-entry STORED zip of exactly `total` bytes, written in place (no second copy). */
function storedZipOfSize(total: number, name = 'big.png'): ArrayBuffer {
  const n = enc.encode(name);
  const dataLen = total - (30 + n.length) - (46 + n.length) - 22;
  const u8 = new Uint8Array(total);
  const v = new DataView(u8.buffer);
  v.setUint32(0, 0x04034b50, true);
  v.setUint16(4, 20, true);
  v.setUint32(18, dataLen, true);
  v.setUint32(22, dataLen, true);
  v.setUint16(26, n.length, true);
  u8.set(n, 30);
  const cd = 30 + n.length + dataLen;
  v.setUint32(cd, 0x02014b50, true);
  v.setUint16(cd + 4, 20, true);
  v.setUint16(cd + 6, 20, true);
  v.setUint32(cd + 20, dataLen, true);
  v.setUint32(cd + 24, dataLen, true);
  v.setUint16(cd + 28, n.length, true);
  u8.set(n, cd + 46);
  const eocd = cd + 46 + n.length;
  v.setUint32(eocd, 0x06054b50, true);
  v.setUint16(eocd + 8, 1, true);
  v.setUint16(eocd + 10, 1, true);
  v.setUint32(eocd + 12, 46 + n.length, true);
  v.setUint32(eocd + 16, cd, true);
  return u8.buffer;
}

/** Rewrite a single-entry zip's declared uncompressed size in BOTH headers (a consistent lie). */
function lieAboutSize(zip: ArrayBuffer, size: number): ArrayBuffer {
  const copy = zip.slice(0);
  const v = new DataView(copy);
  const eocd = copy.byteLength - 22;
  const cd = v.getUint32(eocd + 16, true);
  v.setUint32(22, size, true);
  v.setUint32(cd + 24, size, true);
  return copy;
}

const jszip = async (
  files: Record<string, string | Uint8Array | null>,
  options: { compression?: 'STORE' | 'DEFLATE'; streamFiles?: boolean } = {}
) => {
  const zip = new JSZip();
  for (const [name, content] of Object.entries(files)) {
    if (content === null) zip.folder(name);
    else zip.file(name, content);
  }
  const u8 = await zip.generateAsync({
    type: 'uint8array',
    compression: options.compression ?? 'STORE',
    streamFiles: options.streamFiles ?? false,
  });
  return u8.slice().buffer;
};

/** The accepted-zip result the handler hands to verifySaveBytesContent. */
const prepared = (
  _zip: ArrayBuffer,
  deflatedEntries: SaveZipDeflatedEntry[]
): PreparedSaveBytes => ({
  ok: true,
  type: 'application/zip',
  filename: 'x.zip',
  deflated: deflatedEntries,
});

const refusal = (bytes: ArrayBuffer) => {
  const r = validateSaveZip(bytes);
  return r.ok ? 'ok' : r.error;
};

const DATASET = {
  'images/001.png': new Uint8Array([...PNG_HEAD, 1, 2, 3]),
  'images/002.jpg': new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 9, 9]),
  'images/003.jpeg': new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 7]),
  'images/004.webp': enc.encode('RIFF....WEBPVP8 '),
  'images/001.txt': 'a cat, sitting, sunlight',
  'images/002.TXT': 'a dog',
  'meta.json': '{"trigger":"my-dataset"}',
  'tags.csv': 'file,tags\n001.png,cat\n',
};

// ── Real zips (jszip) ───────────────────────────────────────────────────────────────────────────

describe('validateSaveZip — real zips written by jszip', () => {
  it('accepts a STORED image + caption dataset with folders', async () => {
    const zip = await jszip({ ...DATASET, 'images/': null, 'empty/': null });
    expect(validateSaveZip(zip)).toEqual({ ok: true, entryCount: 10, deflated: [] });
  });

  it('accepts a DEFLATE dataset and lists every deflated entry for the inflate check', async () => {
    const zip = await jszip(DATASET, { compression: 'DEFLATE' });
    const r = validateSaveZip(zip);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // 8 files + the 'images/' folder jszip adds for them (stored, so not in `deflated`).
    expect(r.entryCount).toBe(9);
    expect(r.deflated).toHaveLength(8);
    expect(await verifySaveBytesContent(zip, prepared(zip, r.deflated))).toBeNull();
  });

  it('accepts data-descriptor zips (jszip streamFiles), stored and deflated', async () => {
    for (const compression of ['STORE', 'DEFLATE'] as const) {
      const zip = await jszip(DATASET, { compression, streamFiles: true });
      expect(refusal(zip)).toBe('ok');
    }
  });

  it('refuses an empty archive', async () => {
    expect(refusal(await jszip({}))).toBe(SAVE_ZIP_EMPTY_ERROR);
  });

  it('refuses a REAL deflate bomb by its declared ratio, before inflating anything', async () => {
    // 8 MB of one byte deflates to a few KB: a ratio far over 100.
    const zip = await jszip({ 'bomb.txt': 'A'.repeat(8 * MB) }, { compression: 'DEFLATE' });
    expect(zip.byteLength).toBeLessThan(64 * 1024);
    expect(refusal(zip)).toBe(SAVE_ZIP_RATIO_ERROR);
  });

  it.each([
    ['payload.exe', 'exe'],
    ['index.html', 'html'],
    ['icon.svg', 'svg'],
    ['inner.zip', 'zip'],
    ['nested/archive.7z', '7z'],
    ['photo.png.exe', 'exe'],
    ['run.sh', 'sh'],
    ['README', ''],
    ['trailing-dot.png.', ''],
  ])('refuses a %s entry (allowlist): %s', async (name, ext) => {
    const zip = await jszip({ 'ok.png': new Uint8Array(PNG_HEAD), [name]: 'x' });
    expect(refusal(zip)).toBe(saveZipEntryTypeError(ext));
  });
});

// ── Raw builder: positive control first ─────────────────────────────────────────────────────────

describe('validateSaveZip — hand-built zips', () => {
  it('POSITIVE CONTROL: the builder baseline is valid (stored, deflated, both descriptor forms)', () => {
    expect(refusal(buildZip([file('a.txt')]))).toBe('ok');
    expect(refusal(buildZip([file('a.txt'), file('dir/b.json', '{}'), { name: 'dir/' }]))).toBe(
      'ok'
    );
    expect(refusal(buildZip([deflated('c.csv', enc.encode('x,y\n'.repeat(50)))]))).toBe('ok');
    expect(refusal(buildZip([{ ...file('d.txt'), descriptor: 'sig' }]))).toBe('ok');
    expect(refusal(buildZip([{ ...file('e.txt'), descriptor: 'nosig' }, file('f.txt')]))).toBe(
      'ok'
    );
    // Unix mode bits for a regular file and a directory are fine.
    expect(
      refusal(
        buildZip([
          { ...file('g.txt'), externalAttrs: (0o100644 << 16) >>> 0 },
          { name: 'h/', externalAttrs: (0o040755 << 16) >>> 0 },
        ])
      )
    ).toBe('ok');
  });

  describe('names', () => {
    it.each([
      ['../evil.txt', SAVE_ZIP_TRAVERSAL_ERROR],
      ['a/../../evil.txt', SAVE_ZIP_TRAVERSAL_ERROR],
      ['a/b/../c.txt', SAVE_ZIP_TRAVERSAL_ERROR],
      ['/etc/cron.d/x.txt', SAVE_ZIP_ABSOLUTE_PATH_ERROR],
      ['..\\evil.txt', SAVE_ZIP_BACKSLASH_ERROR],
      ['a\\b.txt', SAVE_ZIP_BACKSLASH_ERROR],
      ['C:/Windows/x.txt', SAVE_ZIP_DRIVE_OR_COLON_ERROR],
      ['C:x.txt', SAVE_ZIP_DRIVE_OR_COLON_ERROR],
      ['notes.txt:hidden.exe', SAVE_ZIP_DRIVE_OR_COLON_ERROR],
      ['a//b.txt', SAVE_ZIP_EMPTY_SEGMENT_ERROR],
      ['./a.txt', SAVE_ZIP_EMPTY_SEGMENT_ERROR],
      ['a/./b.txt', SAVE_ZIP_EMPTY_SEGMENT_ERROR],
      ['cap\u0000tion.txt', SAVE_ZIP_CONTROL_CHAR_ERROR],
      ['line\nbreak.txt', SAVE_ZIP_CONTROL_CHAR_ERROR],
      ['inv\u202Etxt.exe', SAVE_ZIP_CONTROL_CHAR_ERROR],
      ['zero\u200Bwidth.png', SAVE_ZIP_CONTROL_CHAR_ERROR],
      ['iso\u2067x\u2069.txt', SAVE_ZIP_CONTROL_CHAR_ERROR],
    ])('refuses %j', (name, error) => {
      // UTF-8 flag set so the non-ASCII cases reach the name rules, not the encoding rule.
      expect(refusal(buildZip([file('ok.txt'), { ...file('x'), name, flags: 1 << 11 }]))).toBe(
        error
      );
    });

    it('refuses a non-ASCII name without the UTF-8 flag, and invalid UTF-8 with it', () => {
      const latin1 = new Uint8Array([0x63, 0x61, 0x66, 0xe9, 0x2e, 0x74, 0x78, 0x74]); // café.txt
      expect(refusal(buildZip([{ ...file('x'), name: latin1 }]))).toBe(
        SAVE_ZIP_NAME_ENCODING_ERROR
      );
      expect(refusal(buildZip([{ ...file('x'), name: latin1, flags: 1 << 11 }]))).toBe(
        SAVE_ZIP_NAME_ENCODING_ERROR
      );
      // A real UTF-8 name with the flag is accepted.
      expect(refusal(buildZip([{ ...file('x'), name: 'café.txt', flags: 1 << 11 }]))).toBe('ok');
    });

    it('refuses duplicate names — exact, case-insensitive, NFC/NFD, and file vs directory', () => {
      expect(refusal(buildZip([file('a.txt'), file('a.txt')]))).toBe(SAVE_ZIP_DUPLICATE_NAME_ERROR);
      expect(refusal(buildZip([file('IMG.png'), file('img.PNG')]))).toBe(
        SAVE_ZIP_DUPLICATE_NAME_ERROR
      );
      const nfc = '\u00e9.txt';
      const nfd = 'e\u0301.txt';
      expect(
        refusal(
          buildZip([
            { ...file('x'), name: nfc, flags: 1 << 11 },
            { ...file('x'), name: nfd, flags: 1 << 11 },
          ])
        )
      ).toBe(SAVE_ZIP_DUPLICATE_NAME_ERROR);
      expect(refusal(buildZip([{ name: 'x.txt/' }, file('x.txt')]))).toBe(
        SAVE_ZIP_DUPLICATE_NAME_ERROR
      );
    });

    it('refuses an entry under a path another entry claims as a file', () => {
      expect(refusal(buildZip([file('a.txt'), file('a.txt/b.txt')]))).toBe(
        SAVE_ZIP_PATH_CONFLICT_ERROR
      );
      expect(refusal(buildZip([file('d/a.txt/b/c.txt'), file('D/A.TXT')]))).toBe(
        SAVE_ZIP_PATH_CONFLICT_ERROR
      );
    });

    it('refuses an Info-ZIP Unicode Path extra field (an extractor may use it instead of the name)', () => {
      const alt = extraField(0x7075, [1, 0, 0, 0, 0, 0x2e, 0x2e]);
      expect(refusal(buildZip([{ ...file('a.txt'), extra: alt }]))).toBe(
        SAVE_ZIP_ALTERNATE_PATH_ERROR
      );
      expect(refusal(buildZip([{ ...file('a.txt'), localExtra: alt }]))).toBe(
        SAVE_ZIP_ALTERNATE_PATH_ERROR
      );
    });
  });

  describe('entry kinds', () => {
    it('refuses a symlink and other special files by their Unix mode', () => {
      for (const mode of [0o120777, 0o060644, 0o020644, 0o010644, 0o140755]) {
        expect(
          refusal(
            buildZip([{ ...file('link.txt', '/etc/passwd'), externalAttrs: (mode << 16) >>> 0 }])
          )
        ).toBe(SAVE_ZIP_SPECIAL_FILE_ERROR);
      }
    });

    it('refuses a directory entry that carries data', () => {
      expect(refusal(buildZip([{ name: 'dir/', data: enc.encode('hidden') }]))).toBe(
        SAVE_ZIP_DIRECTORY_DATA_ERROR
      );
    });

    it('refuses encrypted entries: the flag bits and the encryption extra fields', () => {
      expect(refusal(buildZip([{ ...file('a.txt'), flags: 1 }]))).toBe(SAVE_ZIP_ENCRYPTED_ERROR);
      expect(refusal(buildZip([{ ...file('a.txt'), flags: 1 << 6 }]))).toBe(
        SAVE_ZIP_ENCRYPTED_ERROR
      );
      expect(refusal(buildZip([{ ...file('a.txt'), flags: 1 << 13 }]))).toBe(
        SAVE_ZIP_ENCRYPTED_ERROR
      );
      expect(
        refusal(
          buildZip([{ ...file('a.txt'), extra: extraField(0x9901, [2, 0, 0x41, 0x45, 3, 8, 0]) }])
        )
      ).toBe(SAVE_ZIP_ENCRYPTED_ERROR);
      expect(refusal(buildZip([{ ...file('a.txt'), extra: extraField(0x0017) }]))).toBe(
        SAVE_ZIP_ENCRYPTED_ERROR
      );
    });

    it('refuses an unknown general-purpose flag bit', () => {
      expect(refusal(buildZip([{ ...file('a.txt'), flags: 1 << 5 }]))).toBe(SAVE_ZIP_FLAGS_ERROR);
      expect(refusal(buildZip([{ ...file('a.txt'), flags: 1 << 12 }]))).toBe(SAVE_ZIP_FLAGS_ERROR);
    });

    it.each([1, 6, 9, 12, 14, 93, 95, 98, 99])('refuses compression method %i', (method) => {
      expect(refusal(buildZip([{ ...file('a.txt'), method }]))).toBe(saveZipMethodError(method));
    });

    it('refuses a stored entry whose sizes disagree', () => {
      expect(refusal(buildZip([{ ...file('a.txt', 'abc'), size: 7 }]))).toBe(
        SAVE_ZIP_STORED_SIZE_ERROR
      );
    });
  });

  describe('central directory vs local headers', () => {
    it('refuses a local name that differs from the central-directory name', () => {
      expect(refusal(buildZip([{ ...file('a.txt'), localName: 'a.exe' }]))).toBe(
        SAVE_ZIP_HEADER_MISMATCH_ERROR
      );
      // Same length, one byte different — and a different LENGTH.
      expect(refusal(buildZip([{ ...file('caption.txt'), localName: '../pwn.txt' }]))).toBe(
        SAVE_ZIP_HEADER_MISMATCH_ERROR
      );
      expect(refusal(buildZip([{ ...file('a.txt'), localName: 'a.txt.exe' }]))).toBe(
        SAVE_ZIP_HEADER_MISMATCH_ERROR
      );
    });

    it('refuses a local method, flags, CRC or size that differs', () => {
      expect(refusal(buildZip([{ ...file('a.txt'), localMethod: 8 }]))).toBe(
        SAVE_ZIP_HEADER_MISMATCH_ERROR
      );
      expect(refusal(buildZip([{ ...file('a.txt'), localFlags: 1 << 11 }]))).toBe(
        SAVE_ZIP_HEADER_MISMATCH_ERROR
      );
      expect(refusal(buildZip([{ ...file('a.txt'), local: { crc: 0xdeadbeef } }]))).toBe(
        SAVE_ZIP_HEADER_MISMATCH_ERROR
      );
      expect(refusal(buildZip([{ ...file('a.txt'), local: { size: 3 } }]))).toBe(
        SAVE_ZIP_HEADER_MISMATCH_ERROR
      );
      expect(refusal(buildZip([{ ...file('a.txt'), local: { compressedSize: 3 } }]))).toBe(
        SAVE_ZIP_HEADER_MISMATCH_ERROR
      );
    });

    it('refuses a zeroed local header when the entry declares no data descriptor', () => {
      // Zeros are only legitimate when bit 3 says the real values follow the data.
      expect(
        refusal(buildZip([{ ...file('a.txt'), local: { crc: 0, compressedSize: 0, size: 0 } }]))
      ).toBe(SAVE_ZIP_HEADER_MISMATCH_ERROR);
    });

    it('refuses a data descriptor that disagrees, or one of the wrong length', () => {
      const e = { ...file('a.txt', 'abcd'), descriptor: 'sig' as const };
      expect(
        refusal(
          buildZip([{ ...e, descriptorValues: { crc: 0x1234abcd, compressedSize: 4, size: 5 } }])
        )
      ).toBe(SAVE_ZIP_DATA_DESCRIPTOR_ERROR);
      // zip64-shaped descriptor tail: 4 extra bytes after a valid one.
      expect(refusal(buildZip([{ ...e, after: new Uint8Array(4) }]))).toBe(
        SAVE_ZIP_DATA_DESCRIPTOR_ERROR
      );
      // A 16-byte descriptor whose signature is wrong (the 12 value bytes after it are right).
      expect(refusal(buildZip([{ ...e, descriptorSig: 0xdeadbeef }]))).toBe(
        SAVE_ZIP_DATA_DESCRIPTOR_ERROR
      );
      // 20 bytes: a correct 12-byte descriptor followed by 8 more (a zip64 descriptor's length).
      expect(refusal(buildZip([{ ...e, descriptor: 'nosig', after: new Uint8Array(8) }]))).toBe(
        SAVE_ZIP_DATA_DESCRIPTOR_ERROR
      );
      // 16 bytes without the signature.
      expect(refusal(buildZip([{ ...e, descriptor: 'nosig', after: new Uint8Array(4) }]))).toBe(
        SAVE_ZIP_DATA_DESCRIPTOR_ERROR
      );
    });

    it('refuses a corrupted local-header signature', () => {
      const zip = buildZip([file('a.txt'), file('b.txt')]);
      const second = 30 + 5 + 'caption text'.length;
      new DataView(zip).setUint32(second, 0x04034b51, true);
      expect(refusal(zip)).toBe(SAVE_ZIP_LOCAL_HEADER_ERROR);
    });

    it('refuses a SMUGGLED local entry the central directory does not list (polyglot)', () => {
      // A reader walking local headers sees `evil.exe`; one reading the directory does not.
      const hidden = new Uint8Array(buildZip([file('evil.exe', 'MZ')]).slice(0, 30 + 8 + 2));
      expect(refusal(buildZip([{ ...file('a.txt'), after: hidden }, file('b.txt')]))).toBe(
        SAVE_ZIP_LAYOUT_ERROR
      );
      expect(refusal(buildZip([file('a.txt')], { beforeCd: hidden }))).toBe(SAVE_ZIP_LAYOUT_ERROR);
    });

    it('refuses two directory records pointing at ONE local header', () => {
      expect(refusal(buildZip([file('a.txt'), { ...file('a2.txt'), localOffset: 0 }]))).toBe(
        SAVE_ZIP_LAYOUT_ERROR
      );
    });
  });

  describe('archive structure', () => {
    it('refuses trailing data, an archive comment, and a missing EOCD', () => {
      expect(refusal(buildZip([file('a.txt')], { trailing: enc.encode('junk') }))).toBe(
        SAVE_ZIP_NO_EOCD_ERROR
      );
      expect(refusal(buildZip([file('a.txt')], { comment: enc.encode('hello') }))).toBe(
        SAVE_ZIP_NO_EOCD_ERROR
      );
      const zip = buildZip([file('a.txt')]);
      expect(refusal(zip.slice(0, zip.byteLength - 1))).toBe(SAVE_ZIP_NO_EOCD_ERROR);
    });

    it('refuses a buffer too short to hold an EOCD', () => {
      expect(refusal(new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x14, 0, 0, 0]).buffer)).toBe(
        SAVE_ZIP_TRUNCATED_ERROR
      );
    });

    it('refuses an EOCD that declares a comment which is not there', () => {
      // The last 22 bytes ARE an EOCD, so only the comment-length rule can refuse it.
      expect(refusal(buildZip([file('a.txt')], { eocd: { commentLen: 5 } }))).toBe(
        SAVE_ZIP_NO_EOCD_ERROR
      );
    });

    it('refuses data in front of the first local header', () => {
      // A complete smuggled local entry before the real one; the directory points past it.
      const hidden = new Uint8Array(buildZip([file('evil.exe', 'MZ')]).slice(0, 30 + 8 + 2));
      expect(refusal(buildZip([file('a.txt')], { prefix: hidden }))).toBe(SAVE_ZIP_LAYOUT_ERROR);
    });

    it('refuses a corrupted central-directory signature', () => {
      const zip = buildZip([file('a.txt')]);
      const v = new DataView(zip);
      const cd = v.getUint32(zip.byteLength - 22 + 16, true);
      v.setUint32(cd, 0x02014b51, true);
      expect(refusal(zip)).toBe(SAVE_ZIP_CENTRAL_DIRECTORY_ERROR);
    });

    it('refuses a central record whose name runs past the directory', () => {
      const zip = buildZip([file('a.txt')]);
      const v = new DataView(zip);
      const cd = v.getUint32(zip.byteLength - 22 + 16, true);
      v.setUint16(cd + 28, 2_000, true);
      expect(refusal(zip)).toBe(SAVE_ZIP_CENTRAL_DIRECTORY_ERROR);
    });

    it('refuses bytes between the central directory and the EOCD', () => {
      expect(refusal(buildZip([file('a.txt')], { beforeEocd: new Uint8Array(3) }))).toBe(
        SAVE_ZIP_LAYOUT_ERROR
      );
    });

    it('refuses an EOCD count that does not match the directory', () => {
      const two = buildZip([file('a.txt'), file('b.txt')], {
        eocd: { totalEntries: 1, entriesOnDisk: 1 },
      });
      expect(refusal(two)).toBe(SAVE_ZIP_CENTRAL_DIRECTORY_ERROR);
      const one = buildZip([file('a.txt')], { eocd: { totalEntries: 2, entriesOnDisk: 2 } });
      expect(refusal(one)).toBe(SAVE_ZIP_CENTRAL_DIRECTORY_ERROR);
    });

    it('refuses an entry that starts on another disk', () => {
      expect(refusal(buildZip([{ ...file('a.txt'), diskStart: 1 }]))).toBe(
        SAVE_ZIP_MULTIDISK_ERROR
      );
    });

    it('refuses multi-disk archives', () => {
      expect(refusal(buildZip([file('a.txt')], { eocd: { disk: 1 } }))).toBe(
        SAVE_ZIP_MULTIDISK_ERROR
      );
      expect(refusal(buildZip([file('a.txt')], { eocd: { entriesOnDisk: 0 } }))).toBe(
        SAVE_ZIP_MULTIDISK_ERROR
      );
    });

    it('refuses every zip64 marker rather than parsing it', () => {
      expect(
        refusal(
          buildZip([{ ...file('a.txt'), extra: extraField(0x0001, [0, 0, 0, 0, 0, 0, 0, 0]) }])
        )
      ).toBe(SAVE_ZIP64_ERROR);
      expect(
        refusal(
          buildZip([{ ...file('a.txt'), localExtra: extraField(0x0001, [0, 0, 0, 0, 0, 0, 0, 0]) }])
        )
      ).toBe(SAVE_ZIP64_ERROR);
      expect(refusal(buildZip([{ ...file('a.txt'), size: 0xffffffff, method: 8 }]))).toBe(
        SAVE_ZIP64_ERROR
      );
      expect(refusal(buildZip([{ ...file('a.txt'), compressedSize: 0xffffffff, method: 8 }]))).toBe(
        SAVE_ZIP64_ERROR
      );
      expect(
        refusal(
          buildZip([file('a.txt')], { eocd: { totalEntries: 0xffff, entriesOnDisk: 0xffff } })
        )
      ).toBe(SAVE_ZIP64_ERROR);
      expect(refusal(buildZip([file('a.txt')], { eocd: { cdOffset: 0xffffffff } }))).toBe(
        SAVE_ZIP64_ERROR
      );
      // A zip64 EOCD locator right before the EOCD.
      const locator = new Uint8Array(20);
      new DataView(locator.buffer).setUint32(0, 0x07064b50, true);
      expect(refusal(buildZip([file('a.txt')], { beforeEocd: locator }))).toBe(SAVE_ZIP64_ERROR);
    });

    it('refuses a malformed extra field block', () => {
      expect(
        refusal(buildZip([{ ...file('a.txt'), extra: new Uint8Array([0x99, 0x99, 9, 0, 1]) }]))
      ).toBe(SAVE_ZIP_EXTRA_FIELD_ERROR);
      expect(refusal(buildZip([{ ...file('a.txt'), extra: new Uint8Array([1, 2, 3]) }]))).toBe(
        SAVE_ZIP_EXTRA_FIELD_ERROR
      );
    });

    it('refuses a compressed size that runs past the central directory', () => {
      expect(refusal(buildZip([{ ...file('a.txt'), method: 8, compressedSize: 5000 }]))).toBe(
        SAVE_ZIP_TRUNCATED_ERROR
      );
    });
  });

  describe('bounds (declared sizes)', () => {
    const { maxEntries, maxTotalUncompressedBytes, maxEntryRatio, ratioFloorBytes } =
      SAVE_ZIP_LIMITS;

    it('pins the chosen bounds', () => {
      expect(SAVE_ZIP_LIMITS).toEqual({
        maxEntries: 10_000,
        maxTotalUncompressedBytes: 1024 * MB,
        maxEntryRatio: 100,
        ratioFloorBytes: MB,
      });
    });

    it(`accepts ${maxEntries} entries and refuses ${maxEntries + 1}`, () => {
      const many = (n: number) =>
        Array.from({ length: n }, (_, i) => ({ name: `d/${String(i).padStart(5, '0')}.txt` }));
      expect(refusal(buildZip(many(maxEntries)))).toBe('ok');
      expect(refusal(buildZip(many(maxEntries + 1)))).toBe(SAVE_ZIP_TOO_MANY_ENTRIES_ERROR);
    });

    it('per-entry ratio: exactly 100× is accepted, one byte more is refused; small entries are exempt', () => {
      // 20,000 bytes of (fake) deflate data, not a power of two; 100× of it is over the 1 MiB floor.
      const csize = 20_000;
      expect(maxEntryRatio * csize).toBeGreaterThan(ratioFloorBytes);
      const data = new Uint8Array(csize).fill(7);
      const entry = (size: number) => ({ name: 'r.txt', method: 8, data, size });
      expect(refusal(buildZip([entry(maxEntryRatio * csize)]))).toBe('ok');
      expect(refusal(buildZip([entry(maxEntryRatio * csize + 1)]))).toBe(SAVE_ZIP_RATIO_ERROR);
      // 10 compressed bytes declaring 1,000,000 (100,000×) — under the 1 MiB floor, so allowed here
      // (the total cap and the inflate check still bound it).
      expect(
        refusal(buildZip([{ name: 's.txt', method: 8, data: new Uint8Array(10), size: 1_000_000 }]))
      ).toBe('ok');
      expect(
        refusal(
          buildZip([
            { name: 's.txt', method: 8, data: new Uint8Array(10), size: ratioFloorBytes + 1 },
          ])
        )
      ).toBe(SAVE_ZIP_RATIO_ERROR);
    });

    it('total declared size: exactly 1 GiB is accepted, one byte more is refused', () => {
      // Six deflated entries of 3,000,001 compressed bytes each, each declaring < 100× that, summing
      // to exactly the cap — so neither the ratio nor the entry count is the reason.
      const csize = 3_000_001;
      const data = new Uint8Array(csize).fill(3);
      const each = Math.floor(maxTotalUncompressedBytes / 6);
      const last = maxTotalUncompressedBytes - each * 5;
      expect(last).toBeLessThan(maxEntryRatio * csize);
      const entries = (extra: number) =>
        [each, each, each, each, each, last + extra].map((size, i) => ({
          name: `p${i}.txt`,
          method: 8,
          data,
          size,
        }));
      expect(refusal(buildZip(entries(0)))).toBe('ok');
      expect(refusal(buildZip(entries(1)))).toBe(SAVE_ZIP_TOTAL_SIZE_ERROR);
    });
  });
});

// ── Inflate check: declared sizes cannot be walked by lying ─────────────────────────────────────

describe('verifySaveBytesContent — the inflate check', () => {
  it('refuses a deflated entry that inflates to MORE than it declares (a lying bomb)', async () => {
    const real = await jszip(
      { 'zeros.txt': new Uint8Array(5 * MB + 3) },
      { compression: 'DEFLATE' }
    );
    // Declare a size that keeps the ratio under 100× so only the inflate check can catch it.
    const lie = lieAboutSize(real, 9_999);
    const v = validateSaveZip(lie);
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    expect(await verifySaveBytesContent(lie, prepared(lie, v.deflated))).toBe(
      SAVE_ZIP_INFLATE_ERROR
    );
  });

  it('refuses a deflated entry that inflates to LESS than it declares', async () => {
    const real = await jszip({ 'a.txt': 'short caption' }, { compression: 'DEFLATE' });
    const lie = lieAboutSize(real, 'short caption'.length + 1);
    const v = validateSaveZip(lie);
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    expect(await verifySaveBytesContent(lie, prepared(lie, v.deflated))).toBe(
      SAVE_ZIP_INFLATE_ERROR
    );
  });

  it('refuses data that is not a deflate stream at all', async () => {
    const zip = buildZip([
      { name: 'a.txt', method: 8, data: new Uint8Array([0xff, 0xff, 0xff, 0xff]), size: 4 },
    ]);
    const v = validateSaveZip(zip);
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    expect(await verifySaveBytesContent(zip, prepared(zip, v.deflated))).toBe(
      SAVE_ZIP_INFLATE_ERROR
    );
  });

  it('is a no-op for non-zip types', async () => {
    expect(
      await verifySaveBytesContent(new ArrayBuffer(4), {
        ok: true,
        type: 'text/plain',
        filename: 'a.txt',
      })
    ).toBeNull();
  });
});

// ── Classification and the save path ───────────────────────────────────────────────────────────

describe('zip classification on the save path', () => {
  it('classifies a valid zip by CONTENT and always names it .zip', async () => {
    const zip = await jszip(DATASET);
    expect(classifySaveBytes(zip, 'whatever.png')).toBe('application/zip');
    for (const [filename, saved] of [
      ['dataset.zip', 'dataset.zip'],
      ['dataset', 'dataset.zip'],
      ['dataset.png', 'dataset.zip'],
      ['../../evil.exe', 'evil.zip'],
      [undefined, 'download.zip'],
    ] as const) {
      expect(prepareSaveBytes({ bytes: zip, filename })).toMatchObject({
        ok: true,
        type: 'application/zip',
        filename: saved,
      });
    }
  });

  it('a non-zip named .zip is classified by content: text saves as .txt, binary is refused', () => {
    const text = enc.encode('not a zip at all').buffer as ArrayBuffer;
    expect(prepareSaveBytes({ bytes: text, filename: 'dataset.zip' })).toEqual({
      ok: true,
      type: 'text/plain',
      filename: 'dataset.txt',
    });
    const binary = new Uint8Array([0x00, 0x01, 0x02, 0xfe]).buffer;
    expect(prepareSaveBytes({ bytes: binary, filename: 'dataset.zip' })).toEqual({
      ok: false,
      error: 'file type is not allowed',
    });
  });

  it('a PNG with a zip APPENDED is a PNG (image sniff wins), saved as .png — decided, not accidental', async () => {
    const zip = new Uint8Array(await jszip({ 'payload.exe': 'MZ' }));
    const poly = new Uint8Array(PNG_HEAD.length + zip.length);
    poly.set(PNG_HEAD);
    poly.set(zip, PNG_HEAD.length);
    expect(classifySaveBytesContent(poly.buffer, 'x.zip')).toEqual({ ok: true, type: 'image/png' });
    expect(prepareSaveBytes({ bytes: poly.buffer, filename: 'x.zip' })).toEqual({
      ok: true,
      type: 'image/png',
      filename: 'x.png',
    });
  });

  it('a zip behind any non-image prefix (a self-extractor) is refused, never unwrapped', async () => {
    const zip = new Uint8Array(await jszip({ 'a.txt': 'x' }));
    const sfx = new Uint8Array(2 + zip.length);
    sfx.set([0x4d, 0x5a]); // MZ
    sfx.set(zip, 2);
    expect(prepareSaveBytes({ bytes: sfx.buffer, filename: 'a.zip' })).toEqual({
      ok: false,
      error: 'file type is not allowed',
    });
  });

  it('a refused zip reports the zip reason, not a generic type error, and never falls back to text', () => {
    const zip = buildZip([file('evil.html', '<script>')]);
    expect(prepareSaveBytes({ bytes: zip, filename: 'x.zip' })).toEqual({
      ok: false,
      error: 'zip entry type is not allowed: html',
    });
  });

  it('a bare "application/zip" from a classifier double is refused (no entries to inflate-check)', () => {
    expect(prepareSaveBytes({ bytes: new ArrayBuffer(4) }, () => 'application/zip')).toEqual({
      ok: false,
      error: 'file type is not allowed',
    });
  });
});

describe('zip size caps on the path the handler calls (processSaveBytes)', () => {
  const T0 = 9_000_000;

  it('pins the zip caps: 256 MB per file and per window, other types unchanged', () => {
    expect(SAVE_ZIP_MAX_BYTES).toBe(256 * MB);
    expect(SAVE_BYTES_ZIP_MAX_BYTES).toBe(256 * MB);
    expect(SAVE_BYTES_ZIP_MAX_BYTES_PER_WINDOW).toBe(256 * MB);
    expect(SAVE_BYTES_MAX_BYTES).toBe(50 * MB);
  });

  it('a zip AT 256 MB is accepted; one byte over is too large', () => {
    const atCap = storedZipOfSize(SAVE_BYTES_ZIP_MAX_BYTES);
    const ok = processSaveBytes({ bytes: atCap, filename: 'dataset.zip' }, [], T0);
    expect(ok.result).toMatchObject({ ok: true, type: 'application/zip', filename: 'dataset.zip' });
    expect(ok.recent).toEqual([{ at: T0, size: SAVE_BYTES_ZIP_MAX_BYTES }]);

    const over = storedZipOfSize(SAVE_BYTES_ZIP_MAX_BYTES + 1);
    const refused = processSaveBytes({ bytes: over, filename: 'dataset.zip' }, [], T0 + 1);
    expect(refused.result).toEqual({ ok: false, error: 'file exceeds the maximum save size' });
    expect(refused.recent).toEqual([]);
  });

  it('the raised cap is for zips only: a 61 MB zip is accepted, 61 MB of text is too large', () => {
    const size = 61 * MB + 7;
    const zip = processSaveBytes({ bytes: storedZipOfSize(size) }, [], T0);
    expect(zip.result).toMatchObject({ ok: true, type: 'application/zip' });
    const text = processSaveBytes({ bytes: new Uint8Array(size).fill(0x61).buffer }, [], T0);
    expect(text.result).toEqual({ ok: false, error: 'file exceeds the maximum save size' });
  });

  it('the window: a 130 MB zip fits an empty window (over the 100 MB non-zip budget)…', () => {
    const big = 130 * MB + 11;
    const r = processSaveBytes({ bytes: storedZipOfSize(big) }, [], T0);
    expect(r.result).toMatchObject({ ok: true, type: 'application/zip' });
    // …a following small text save is still held to the 100 MB budget, so it is busy…
    const after = processSaveBytes(
      { bytes: enc.encode('hi').buffer as ArrayBuffer },
      r.recent,
      T0 + 1
    );
    expect(after.result).toEqual({ ok: false, error: 'busy' });
    // …and a second zip that would take the window over 256 MB is busy too.
    const second = processSaveBytes({ bytes: storedZipOfSize(126 * MB + 5) }, r.recent, T0 + 2);
    expect(second.result).toEqual({ ok: false, error: 'busy' });
    const fits = processSaveBytes({ bytes: storedZipOfSize(125 * MB + 5) }, r.recent, T0 + 3);
    expect(fits.result).toMatchObject({ ok: true, type: 'application/zip' });
  });

  it('a full window refuses a zip `busy` WITHOUT validating it (a malformed zip still says busy)', () => {
    const full = Array.from({ length: SAVE_BYTES_MAX_PER_WINDOW }, (_, i) => ({
      at: T0 + i,
      size: 10,
    }));
    const malformed = buildZip([file('evil.exe')]);
    expect(processSaveBytes({ bytes: malformed }, full, T0 + 9).result).toEqual({
      ok: false,
      error: 'busy',
    });
    // Control: with room, the same bytes are refused for their content.
    expect(processSaveBytes({ bytes: malformed }, [], T0 + 9).result).toEqual({
      ok: false,
      error: 'zip entry type is not allowed: exe',
    });
  });
});

describe('error strings', () => {
  it('every zip refusal string is distinct (so a reply names exactly one guard)', () => {
    const all = [
      SAVE_ZIP64_ERROR,
      SAVE_ZIP_ABSOLUTE_PATH_ERROR,
      SAVE_ZIP_ALTERNATE_PATH_ERROR,
      SAVE_ZIP_BACKSLASH_ERROR,
      SAVE_ZIP_CENTRAL_DIRECTORY_ERROR,
      SAVE_ZIP_CONTROL_CHAR_ERROR,
      SAVE_ZIP_DATA_DESCRIPTOR_ERROR,
      SAVE_ZIP_DIRECTORY_DATA_ERROR,
      SAVE_ZIP_DRIVE_OR_COLON_ERROR,
      SAVE_ZIP_DUPLICATE_NAME_ERROR,
      SAVE_ZIP_EMPTY_ERROR,
      SAVE_ZIP_EMPTY_SEGMENT_ERROR,
      SAVE_ZIP_ENCRYPTED_ERROR,
      SAVE_ZIP_EXTRA_FIELD_ERROR,
      SAVE_ZIP_FLAGS_ERROR,
      SAVE_ZIP_HEADER_MISMATCH_ERROR,
      SAVE_ZIP_INFLATE_ERROR,
      SAVE_ZIP_LAYOUT_ERROR,
      SAVE_ZIP_LOCAL_HEADER_ERROR,
      SAVE_ZIP_MULTIDISK_ERROR,
      SAVE_ZIP_NAME_ENCODING_ERROR,
      SAVE_ZIP_NO_EOCD_ERROR,
      SAVE_ZIP_PATH_CONFLICT_ERROR,
      SAVE_ZIP_RATIO_ERROR,
      SAVE_ZIP_SPECIAL_FILE_ERROR,
      SAVE_ZIP_STORED_SIZE_ERROR,
      SAVE_ZIP_TOO_MANY_ENTRIES_ERROR,
      SAVE_ZIP_TOTAL_SIZE_ERROR,
      SAVE_ZIP_TRAVERSAL_ERROR,
      SAVE_ZIP_TRUNCATED_ERROR,
      saveZipEntryTypeError('exe'),
      saveZipMethodError(12),
    ];
    expect(new Set(all).size).toBe(all.length);
    expect(saveZipEntryTypeError('exe')).toBe('zip entry type is not allowed: exe');
    expect(saveZipEntryTypeError('')).toBe('zip entry type is not allowed: (none)');
    expect(saveZipMethodError(12)).toBe('zip compression method is not allowed: 12');
  });
});
