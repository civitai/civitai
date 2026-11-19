import JSZip from 'jszip';
import { describe, expect, it } from 'vitest';
import {
  SAVE_ZIP64_ERROR,
  SAVE_ZIP_ABSOLUTE_PATH_ERROR,
  SAVE_ZIP_ALTERNATE_PATH_ERROR,
  SAVE_ZIP_DUPLICATE_NAME_ERROR,
  SAVE_ZIP_HEADER_MISMATCH_ERROR,
  SAVE_ZIP_SPECIAL_FILE_ERROR,
  SAVE_ZIP_STORED_LOCAL_SIGNATURE_ERROR,
  SAVE_ZIP_TRAVERSAL_ERROR,
  saveZipExtraFieldError,
} from '@civitai/app-sdk/save-zip';
import { prepareSaveBytes, verifySaveBytesContent } from './saveImageDownload';

/**
 * 🔴 A HOST-SIDE FLOOR UNDER THE SHARED ZIP VALIDATOR.
 *
 * The rules live in `@civitai/app-sdk/save-zip` and are tested there, but this repo takes new
 * releases of that package automatically (dependency bumps), so a release that LOOSENED a rule
 * would pass every other test here. These cases pin the refusals this host relies on, through the
 * host's own save path (`prepareSaveBytes`), against the exact error the package exports — so a
 * loosening, or a rename of the reason, fails here in the bump PR.
 */

const enc = new TextEncoder();
const UTF8 = 1 << 11;

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (bytes: Uint8Array) => {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};

type Entry = {
  name: string;
  data?: Uint8Array;
  /** The name written in the LOCAL header (default: `name`). */
  localName?: string;
  flags?: number;
  extra?: Uint8Array;
  localExtra?: Uint8Array;
  externalAttrs?: number;
  /** Write a 16-byte data descriptor after the data, with zero sizes in the local header. */
  descriptor?: boolean;
};

/** A minimal STORED zip writer with real CRCs: local headers, central directory, EOCD. */
function buildZip(entries: readonly Entry[]): ArrayBuffer {
  const parts: number[] = [];
  const u16 = (v: number) => parts.push(v & 0xff, (v >>> 8) & 0xff);
  const u32 = (v: number) =>
    parts.push(v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff);
  const bytes = (b: Uint8Array) => parts.push(...b);
  const offsets: number[] = [];
  for (const e of entries) {
    const data = e.data ?? enc.encode('caption');
    const crc = crc32(data);
    const flags = (e.flags ?? 0) | (e.descriptor ? 1 << 3 : 0);
    const localName = enc.encode(e.localName ?? e.name);
    const localExtra = e.localExtra ?? new Uint8Array(0);
    offsets.push(parts.length);
    u32(0x04034b50);
    u16(20);
    u16(flags);
    u16(0);
    u16(0);
    u16(0x21);
    u32(e.descriptor ? 0 : crc);
    u32(e.descriptor ? 0 : data.length);
    u32(e.descriptor ? 0 : data.length);
    u16(localName.length);
    u16(localExtra.length);
    bytes(localName);
    bytes(localExtra);
    bytes(data);
    if (e.descriptor) {
      u32(0x08074b50);
      u32(crc);
      u32(data.length);
      u32(data.length);
    }
  }
  const cdOffset = parts.length;
  entries.forEach((e, i) => {
    const data = e.data ?? enc.encode('caption');
    const name = enc.encode(e.name);
    const extra = e.extra ?? new Uint8Array(0);
    u32(0x02014b50);
    u16(20);
    u16(20);
    u16((e.flags ?? 0) | (e.descriptor ? 1 << 3 : 0));
    u16(0);
    u16(0);
    u16(0x21);
    u32(crc32(data));
    u32(data.length);
    u32(data.length);
    u16(name.length);
    u16(extra.length);
    u16(0);
    u16(0);
    u16(0);
    u32(e.externalAttrs ?? 0);
    u32(offsets[i]!);
    bytes(name);
    bytes(extra);
  });
  const cdSize = parts.length - cdOffset;
  u32(0x06054b50);
  u16(0);
  u16(0);
  u16(entries.length);
  u16(entries.length);
  u32(cdSize);
  u32(cdOffset);
  u16(0);
  return new Uint8Array(parts).buffer;
}

const extraField = (id: number, body: number[] = [0, 0, 0, 0]) =>
  new Uint8Array([id & 0xff, id >>> 8, body.length & 0xff, body.length >>> 8, ...body]);

/** An Info-ZIP Unicode Path field (0x7075) naming `alt`, with the CRC of the header name `header`. */
const unicodePath = (alt: string, header: string) => {
  const u = enc.encode(alt);
  const c = crc32(enc.encode(header));
  return extraField(0x7075, [1, c & 0xff, (c >>> 8) & 0xff, (c >>> 16) & 0xff, c >>> 24, ...u]);
};

const refusal = (zip: ArrayBuffer) => {
  const r = prepareSaveBytes({ bytes: zip, filename: 'dataset.zip' });
  return r.ok ? 'ok' : r.error;
};

describe('host save path refuses what the shared validator must refuse', () => {
  it('POSITIVE CONTROL: the builder baseline is ACCEPTED (stored, with and without a descriptor)', () => {
    expect(
      refusal(buildZip([{ name: 'images/001.txt' }, { name: 'images/002.txt', descriptor: true }]))
    ).toBe('ok');
  });

  it.each([
    ['path traversal', [{ name: '../evil.txt' }], SAVE_ZIP_TRAVERSAL_ERROR],
    ['an absolute path', [{ name: '/etc/cron.d/x.txt' }], SAVE_ZIP_ABSOLUTE_PATH_ERROR],
    [
      'a symlink (Unix mode 0120777)',
      [{ name: 'link.txt', externalAttrs: (0o120777 << 16) >>> 0 }],
      SAVE_ZIP_SPECIAL_FILE_ERROR,
    ],
    [
      'a central name that differs from the local one',
      [{ name: 'a.txt', localName: 'a.exe' }],
      SAVE_ZIP_HEADER_MISMATCH_ERROR,
    ],
    [
      'a zip64 extra field',
      [{ name: 'a.txt', extra: extraField(0x0001, [0, 0, 0, 0, 0, 0, 0, 0]) }],
      SAVE_ZIP64_ERROR,
    ],
    [
      'duplicate names, case-folded',
      [{ name: 'IMG.txt' }, { name: 'img.TXT' }],
      SAVE_ZIP_DUPLICATE_NAME_ERROR,
    ],
    [
      'a Unicode Path field naming a DIFFERENT path',
      [
        {
          name: 'a.txt',
          flags: UTF8,
          extra: unicodePath('../evil.exe', 'a.txt'),
          localExtra: unicodePath('../evil.exe', 'a.txt'),
        },
      ],
      SAVE_ZIP_ALTERNATE_PATH_ERROR,
    ],
    [
      'a stored + descriptor entry hiding a local-header signature',
      [
        {
          name: 'a.txt',
          descriptor: true,
          data: new Uint8Array([0x61, 0x50, 0x4b, 0x03, 0x04, 0x62]),
        },
      ],
      SAVE_ZIP_STORED_LOCAL_SIGNATURE_ERROR,
    ],
    [
      'an extra field outside the allow-list (0x000d, Unix mode/link)',
      [{ name: 'a.txt', extra: extraField(0x000d) }],
      saveZipExtraFieldError(0x000d),
    ],
  ] as const)('refuses %s', (_name, entries, error) => {
    expect(refusal(buildZip(entries))).toBe(error);
  });

  it('ACCEPTS a real jszip zip with non-ASCII names, and its content check passes', async () => {
    const zip = new JSZip();
    zip.file('画像/001.png', new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1]));
    zip.file('画像/001.txt', '猫');
    zip.file('café.json', '{}');
    const bytes = (await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' })).slice()
      .buffer;
    const prepared = prepareSaveBytes({ bytes, filename: 'données.zip' });
    expect(prepared).toMatchObject({ ok: true, type: 'application/zip' });
    if (!prepared.ok) return;
    expect(await verifySaveBytesContent(bytes, prepared)).toMatchObject({ ok: true });
  });
});
