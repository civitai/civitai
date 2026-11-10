/**
 * App Blocks `SAVE_IMAGE { bytes }` — the `.zip` validator (host side, top frame).
 *
 * An app can save a zip (e.g. an image dataset plus caption files) through the host save path; it
 * gets no `allow-downloads` / `allow-popups` sandbox token for it. A zip is recognised by its
 * STRUCTURE, never its filename, and is saved only after this module has accounted for every byte
 * of it:
 *
 *   [local header + name + extra + data (+ data descriptor)] × N  ·  central directory  ·  EOCD
 *
 * laid end to end with no gap, no prefix, no trailing data and no archive comment. Each central-
 * directory record is cross-checked against the local header it points at (name bytes, flags,
 * method, CRC, sizes), so a reader that walks local headers and one that reads the central
 * directory see the same entries — the polyglot / central-directory-vs-local-header smuggling
 * routes. Then every entry must pass the name and type rules below.
 *
 * Hand-written rather than jszip: jszip's API does not expose the local headers it skips over, and
 * the checks here are about exactly those bytes. No copy of the buffer is made; everything reads
 * through one `DataView` / `Uint8Array` over it.
 *
 * Sizes are the DECLARED ones (central directory), bounded by {@link SAVE_ZIP_LIMITS}. Declared
 * sizes can lie for a deflated entry, so {@link verifySaveZipInflate} then inflates each deflated
 * entry, stopping as soon as it produces more than it declared, and refuses any entry that does not
 * inflate to exactly its declared size. Stored entries need no inflate: their data IS their size.
 *
 * Zip64 is REFUSED, not parsed: a 256 MB save never needs it (it exists for > 4 GiB or > 65,535
 * entries, both far over the caps here), and refusing every zip64 marker — EOCD sentinels, the
 * zip64 EOCD locator, per-entry 0xFFFFFFFF sentinels, the 0x0001 extra field — is simpler to get
 * right than validating a second set of size fields that can disagree with the first.
 */

/** The largest zip a `bytes` save accepts. A dataset of ~200 MB fits with room. */
export const SAVE_ZIP_MAX_BYTES = 256 * 1024 * 1024; // 256 MB

/**
 * The validator's bounds. Each is checked on the DECLARED (central-directory) values before
 * anything is inflated.
 *   - maxEntries 10,000: a large captioned training set (5,000 images + 5,000 captions) still
 *     fits; parsing 10k records is a few ms. Checked on the EOCD count BEFORE the walk.
 *   - maxTotalUncompressedBytes 1 GiB: images (the bulk of a dataset) do not compress, so a real
 *     256 MB zip unpacks to about 256 MB; four times the file cap leaves room for text and bounds
 *     what an extractor writes to the viewer's disk.
 *   - maxEntryRatio 100 above ratioFloorBytes 1 MiB: an entry declaring over 100× its compressed
 *     size is a bomb shape (ordinary text deflates 3–10×). Small entries are exempt — a 4 KB
 *     caption of repeated characters can exceed 100× and is harmless; the total cap bounds them.
 */
export const SAVE_ZIP_LIMITS = {
  maxEntries: 10_000,
  maxTotalUncompressedBytes: 1024 * 1024 * 1024,
  maxEntryRatio: 100,
  ratioFloorBytes: 1024 * 1024,
} as const;

/** Entry extensions a zip may contain (lowercase, after the last `.`). Directories need none. */
export const SAVE_ZIP_ALLOWED_EXTENSIONS: ReadonlySet<string> = new Set([
  'png',
  'jpg',
  'jpeg',
  'webp',
  'txt',
  'json',
  'csv',
]);

export const SAVE_ZIP_NO_EOCD_ERROR =
  'zip end of central directory not found (archive comments are not allowed)';
export const SAVE_ZIP_MULTIDISK_ERROR = 'zip spans multiple disks';
export const SAVE_ZIP64_ERROR = 'zip64 archives are not supported';
export const SAVE_ZIP_EMPTY_ERROR = 'zip has no entries';
export const SAVE_ZIP_TOO_MANY_ENTRIES_ERROR = 'zip has too many entries';
export const SAVE_ZIP_LAYOUT_ERROR = 'zip layout is not contiguous';
export const SAVE_ZIP_TRUNCATED_ERROR = 'zip is truncated';
export const SAVE_ZIP_CENTRAL_DIRECTORY_ERROR = 'zip central directory is malformed';
export const SAVE_ZIP_EXTRA_FIELD_ERROR = 'zip extra field is malformed';
export const SAVE_ZIP_LOCAL_HEADER_ERROR = 'zip local header is malformed';
export const SAVE_ZIP_HEADER_MISMATCH_ERROR =
  'zip local header does not match the central directory';
export const SAVE_ZIP_DATA_DESCRIPTOR_ERROR =
  'zip data descriptor does not match the central directory';
export const SAVE_ZIP_ENCRYPTED_ERROR = 'zip entry is encrypted';
export const SAVE_ZIP_FLAGS_ERROR = 'zip entry uses an unsupported feature';
export const SAVE_ZIP_METHOD_NOT_ALLOWED_ERROR = 'zip compression method is not allowed';
export const SAVE_ZIP_ENTRY_TYPE_NOT_ALLOWED_ERROR = 'zip entry type is not allowed';
export const SAVE_ZIP_NAME_ENCODING_ERROR = 'zip entry name is not valid UTF-8 or ASCII';
export const SAVE_ZIP_ALTERNATE_PATH_ERROR = 'zip entry carries an alternate path field';
export const SAVE_ZIP_CONTROL_CHAR_ERROR = 'zip entry name contains control or bidi characters';
export const SAVE_ZIP_ABSOLUTE_PATH_ERROR = 'zip entry path is absolute';
export const SAVE_ZIP_BACKSLASH_ERROR = 'zip entry path contains a backslash';
export const SAVE_ZIP_DRIVE_OR_COLON_ERROR = 'zip entry path contains a drive letter or colon';
export const SAVE_ZIP_TRAVERSAL_ERROR = 'zip entry path contains a .. segment';
export const SAVE_ZIP_EMPTY_SEGMENT_ERROR = 'zip entry path contains an empty or . segment';
export const SAVE_ZIP_DUPLICATE_NAME_ERROR = 'zip has duplicate entry names';
export const SAVE_ZIP_PATH_CONFLICT_ERROR = 'zip entry is inside a path that is a file';
export const SAVE_ZIP_SPECIAL_FILE_ERROR = 'zip entry is not a regular file or directory';
export const SAVE_ZIP_DIRECTORY_DATA_ERROR = 'zip directory entry has data';
export const SAVE_ZIP_STORED_SIZE_ERROR = 'zip stored entry sizes disagree';
export const SAVE_ZIP_TOTAL_SIZE_ERROR = 'zip total uncompressed size exceeds the limit';
export const SAVE_ZIP_RATIO_ERROR = 'zip entry compression ratio exceeds the limit';
export const SAVE_ZIP_INFLATE_ERROR = 'zip entry does not inflate to its declared size';

/** `zip compression method is not allowed: 12` */
export function saveZipMethodError(method: number): string {
  return `${SAVE_ZIP_METHOD_NOT_ALLOWED_ERROR}: ${method}`;
}

/** `zip entry type is not allowed: exe` (`(none)` for a file with no extension). */
export function saveZipEntryTypeError(ext: string): string {
  return `${SAVE_ZIP_ENTRY_TYPE_NOT_ALLOWED_ERROR}: ${ext.length > 0 ? ext : '(none)'}`;
}

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_EOCD = 0x06054b50;
const SIG_ZIP64_LOCATOR = 0x07064b50;
const SIG_DATA_DESCRIPTOR = 0x08074b50;

const EOCD_LEN = 22;
const ZIP64_LOCATOR_LEN = 20;
const CENTRAL_LEN = 46;
const LOCAL_LEN = 30;

const METHOD_STORED = 0;
const METHOD_DEFLATE = 8;

const FLAG_ENCRYPTED = 1 << 0;
const FLAG_DATA_DESCRIPTOR = 1 << 3;
const FLAG_STRONG_ENCRYPTION = 1 << 6;
const FLAG_UTF8 = 1 << 11;
const FLAG_MASKED_HEADERS = 1 << 13;
/** Bits 1–2 are deflate option hints, 3 the data descriptor, 11 UTF-8 names. Anything else is refused. */
const FLAGS_ALLOWED = (1 << 1) | (1 << 2) | FLAG_DATA_DESCRIPTOR | FLAG_UTF8;

const EXTRA_ZIP64 = 0x0001;
const EXTRA_STRONG_ENCRYPTION = 0x0017;
const EXTRA_UNICODE_PATH = 0x7075;
const EXTRA_AES = 0x9901;

const S_IFMT = 0o170000;
const S_IFREG = 0o100000;
const S_IFDIR = 0o040000;

/** A deflated entry {@link verifySaveZipInflate} must inflate: where its data is and what it declared. */
export type SaveZipDeflatedEntry = { dataOffset: number; compressedSize: number; size: number };

export type SaveZipValidation =
  | { ok: true; entryCount: number; deflated: SaveZipDeflatedEntry[] }
  | { ok: false; error: string };

/** True when the bytes START like a zip (a local header, or the 22-byte empty archive). */
export function looksLikeSaveZip(u8: Uint8Array): boolean {
  if (u8.length < 4 || u8[0] !== 0x50 || u8[1] !== 0x4b) return false;
  return (u8[2] === 0x03 && u8[3] === 0x04) || (u8[2] === 0x05 && u8[3] === 0x06);
}

class ZipRefusal extends Error {}

function refuse(error: string): never {
  throw new ZipRefusal(error);
}

const utf8 = new TextDecoder('utf-8', { fatal: true });

/** Walk an extra field block; refuse a malformed one, zip64, an alternate path, or encryption. */
function checkExtraFields(view: DataView, start: number, len: number): void {
  let p = start;
  const end = start + len;
  while (p < end) {
    if (p + 4 > end) refuse(SAVE_ZIP_EXTRA_FIELD_ERROR);
    const id = view.getUint16(p, true);
    const size = view.getUint16(p + 2, true);
    p += 4;
    if (p + size > end) refuse(SAVE_ZIP_EXTRA_FIELD_ERROR);
    if (id === EXTRA_ZIP64) refuse(SAVE_ZIP64_ERROR);
    if (id === EXTRA_UNICODE_PATH) refuse(SAVE_ZIP_ALTERNATE_PATH_ERROR);
    if (id === EXTRA_STRONG_ENCRYPTION || id === EXTRA_AES) refuse(SAVE_ZIP_ENCRYPTED_ERROR);
    p += size;
  }
}

function decodeName(bytes: Uint8Array, flags: number): string {
  if (flags & FLAG_UTF8) {
    try {
      return utf8.decode(bytes);
    } catch {
      refuse(SAVE_ZIP_NAME_ENCODING_ERROR);
    }
  }
  // No UTF-8 flag: the name is in an unstated legacy code page, which readers decode differently.
  // Only ASCII means the same thing to all of them.
  for (const b of bytes) if (b >= 0x80) refuse(SAVE_ZIP_NAME_ENCODING_ERROR);
  return utf8.decode(bytes);
}

/** Name rules. Returns whether the entry is a directory. */
function checkName(name: string): { isDir: boolean } {
  if (name.length === 0) refuse(SAVE_ZIP_EMPTY_SEGMENT_ERROR);
  // \p{Cc} = C0/C1 controls incl. NUL; \p{Cf} = every bidi override/isolate and zero-width mark.
  if (/[\p{Cc}\p{Cf}]/u.test(name)) refuse(SAVE_ZIP_CONTROL_CHAR_ERROR);
  if (name.includes('\\')) refuse(SAVE_ZIP_BACKSLASH_ERROR);
  if (name.startsWith('/')) refuse(SAVE_ZIP_ABSOLUTE_PATH_ERROR);
  // A colon is a drive letter (`C:x`) or an NTFS alternate data stream (`a.txt:evil.exe`).
  if (name.includes(':')) refuse(SAVE_ZIP_DRIVE_OR_COLON_ERROR);
  const isDir = name.endsWith('/');
  const segments = (isDir ? name.slice(0, -1) : name).split('/');
  for (const seg of segments) {
    if (seg === '..') refuse(SAVE_ZIP_TRAVERSAL_ERROR);
    if (seg === '' || seg === '.') refuse(SAVE_ZIP_EMPTY_SEGMENT_ERROR);
  }
  if (!isDir) {
    const last = segments[segments.length - 1] ?? '';
    const dot = last.lastIndexOf('.');
    const ext = dot >= 0 ? last.slice(dot + 1).toLowerCase() : '';
    if (!SAVE_ZIP_ALLOWED_EXTENSIONS.has(ext)) refuse(saveZipEntryTypeError(ext));
  }
  return { isDir };
}

type CentralEntry = {
  name: Uint8Array;
  flags: number;
  method: number;
  crc: number;
  compressedSize: number;
  size: number;
  localOffset: number;
};

function validate(bytes: ArrayBuffer): SaveZipValidation {
  const u8 = new Uint8Array(bytes);
  const view = new DataView(bytes);
  const len = u8.length;

  // ── EOCD: exactly the last 22 bytes (so no archive comment and nothing after it) ──────────────
  if (len < EOCD_LEN) refuse(SAVE_ZIP_TRUNCATED_ERROR);
  const eocd = len - EOCD_LEN;
  if (view.getUint32(eocd, true) !== SIG_EOCD) refuse(SAVE_ZIP_NO_EOCD_ERROR);
  if (
    eocd >= ZIP64_LOCATOR_LEN &&
    view.getUint32(eocd - ZIP64_LOCATOR_LEN, true) === SIG_ZIP64_LOCATOR
  ) {
    refuse(SAVE_ZIP64_ERROR);
  }
  const diskNumber = view.getUint16(eocd + 4, true);
  const cdDisk = view.getUint16(eocd + 6, true);
  const entriesOnDisk = view.getUint16(eocd + 8, true);
  const totalEntries = view.getUint16(eocd + 10, true);
  const cdSize = view.getUint32(eocd + 12, true);
  const cdOffset = view.getUint32(eocd + 16, true);
  const commentLen = view.getUint16(eocd + 20, true);
  if (totalEntries === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
    refuse(SAVE_ZIP64_ERROR);
  }
  if (commentLen !== 0) refuse(SAVE_ZIP_NO_EOCD_ERROR);
  if (diskNumber !== 0 || cdDisk !== 0 || entriesOnDisk !== totalEntries) {
    refuse(SAVE_ZIP_MULTIDISK_ERROR);
  }
  if (totalEntries === 0) refuse(SAVE_ZIP_EMPTY_ERROR);
  if (totalEntries > SAVE_ZIP_LIMITS.maxEntries) refuse(SAVE_ZIP_TOO_MANY_ENTRIES_ERROR);
  // The central directory ends exactly where the EOCD starts.
  if (cdOffset + cdSize !== eocd) refuse(SAVE_ZIP_LAYOUT_ERROR);

  // ── Central directory ─────────────────────────────────────────────────────────────────────────
  const entries: CentralEntry[] = [];
  let p = cdOffset;
  for (let i = 0; i < totalEntries; i++) {
    if (p + CENTRAL_LEN > eocd) refuse(SAVE_ZIP_CENTRAL_DIRECTORY_ERROR);
    if (view.getUint32(p, true) !== SIG_CENTRAL) refuse(SAVE_ZIP_CENTRAL_DIRECTORY_ERROR);
    const flags = view.getUint16(p + 8, true);
    const method = view.getUint16(p + 10, true);
    const crc = view.getUint32(p + 16, true);
    const compressedSize = view.getUint32(p + 20, true);
    const size = view.getUint32(p + 24, true);
    const nameLen = view.getUint16(p + 28, true);
    const extraLen = view.getUint16(p + 30, true);
    const commentLength = view.getUint16(p + 32, true);
    const diskStart = view.getUint16(p + 34, true);
    const externalAttrs = view.getUint32(p + 38, true);
    const localOffset = view.getUint32(p + 42, true);
    const recordEnd = p + CENTRAL_LEN + nameLen + extraLen + commentLength;
    if (recordEnd > eocd) refuse(SAVE_ZIP_CENTRAL_DIRECTORY_ERROR);
    if (compressedSize === 0xffffffff || size === 0xffffffff || localOffset === 0xffffffff) {
      refuse(SAVE_ZIP64_ERROR);
    }
    if (diskStart !== 0) refuse(SAVE_ZIP_MULTIDISK_ERROR);
    checkExtraFields(view, p + CENTRAL_LEN + nameLen, extraLen);
    if (flags & (FLAG_ENCRYPTED | FLAG_STRONG_ENCRYPTION | FLAG_MASKED_HEADERS)) {
      refuse(SAVE_ZIP_ENCRYPTED_ERROR);
    }
    if (flags & ~FLAGS_ALLOWED) refuse(SAVE_ZIP_FLAGS_ERROR);
    if (method !== METHOD_STORED && method !== METHOD_DEFLATE) refuse(saveZipMethodError(method));
    // Unix mode in the high 16 bits (any host that sets it): only a regular file or a directory.
    // A symlink entry would let a later entry write through it outside the extraction folder.
    const fileType = (externalAttrs >>> 16) & S_IFMT;
    if (fileType !== 0 && fileType !== S_IFREG && fileType !== S_IFDIR) {
      refuse(SAVE_ZIP_SPECIAL_FILE_ERROR);
    }
    entries.push({
      name: u8.subarray(p + CENTRAL_LEN, p + CENTRAL_LEN + nameLen),
      flags,
      method,
      crc,
      compressedSize,
      size,
      localOffset,
    });
    p = recordEnd;
  }
  // Every central-directory byte belongs to a record.
  if (p !== eocd) refuse(SAVE_ZIP_CENTRAL_DIRECTORY_ERROR);

  // ── Names, types, sizes ───────────────────────────────────────────────────────────────────────
  const seen = new Set<string>();
  const files = new Set<string>();
  const paths: { key: string; isDir: boolean }[] = [];
  let total = 0;
  for (const e of entries) {
    const name = decodeName(e.name, e.flags);
    const { isDir } = checkName(name);
    // Case- and normalisation-insensitive, and a dir `a/` equals a file `a`: on a case-
    // insensitive or NFD file system these are the same path, and one silently overwrites the other.
    const key = (isDir ? name.slice(0, -1) : name).normalize('NFC').toLowerCase();
    if (seen.has(key)) refuse(SAVE_ZIP_DUPLICATE_NAME_ERROR);
    seen.add(key);
    if (!isDir) files.add(key);
    paths.push({ key, isDir });
    if (isDir && (e.size !== 0 || e.compressedSize !== 0)) refuse(SAVE_ZIP_DIRECTORY_DATA_ERROR);
    if (e.method === METHOD_STORED && e.compressedSize !== e.size) {
      refuse(SAVE_ZIP_STORED_SIZE_ERROR);
    }
    total += e.size;
    if (total > SAVE_ZIP_LIMITS.maxTotalUncompressedBytes) refuse(SAVE_ZIP_TOTAL_SIZE_ERROR);
    if (
      e.size > SAVE_ZIP_LIMITS.ratioFloorBytes &&
      e.size > SAVE_ZIP_LIMITS.maxEntryRatio * e.compressedSize
    ) {
      refuse(SAVE_ZIP_RATIO_ERROR);
    }
  }
  // No entry may sit under a path another entry claims as a FILE (`a.txt` and `a.txt/b.txt`).
  for (const { key } of paths) {
    let slash = key.indexOf('/');
    while (slash >= 0) {
      if (files.has(key.slice(0, slash))) refuse(SAVE_ZIP_PATH_CONFLICT_ERROR);
      slash = key.indexOf('/', slash + 1);
    }
  }

  // ── Local headers: contiguous from byte 0, each agreeing with its central record ──────────────
  const deflated: SaveZipDeflatedEntry[] = [];
  let cursor = 0;
  for (const [i, e] of entries.entries()) {
    if (e.localOffset !== cursor) refuse(SAVE_ZIP_LAYOUT_ERROR);
    if (cursor + LOCAL_LEN > cdOffset) refuse(SAVE_ZIP_TRUNCATED_ERROR);
    if (view.getUint32(cursor, true) !== SIG_LOCAL) refuse(SAVE_ZIP_LOCAL_HEADER_ERROR);
    const flags = view.getUint16(cursor + 6, true);
    const method = view.getUint16(cursor + 8, true);
    const crc = view.getUint32(cursor + 14, true);
    const compressedSize = view.getUint32(cursor + 18, true);
    const size = view.getUint32(cursor + 22, true);
    const nameLen = view.getUint16(cursor + 26, true);
    const extraLen = view.getUint16(cursor + 28, true);
    const nameStart = cursor + LOCAL_LEN;
    const dataOffset = nameStart + nameLen + extraLen;
    if (dataOffset > cdOffset) refuse(SAVE_ZIP_TRUNCATED_ERROR);
    const localName = u8.subarray(nameStart, nameStart + nameLen);
    if (localName.length !== e.name.length || localName.some((b, j) => b !== e.name[j])) {
      refuse(SAVE_ZIP_HEADER_MISMATCH_ERROR);
    }
    if (flags !== e.flags || method !== e.method) refuse(SAVE_ZIP_HEADER_MISMATCH_ERROR);
    checkExtraFields(view, nameStart + nameLen, extraLen);
    const hasDescriptor = (e.flags & FLAG_DATA_DESCRIPTOR) !== 0;
    const localZero = crc === 0 && compressedSize === 0 && size === 0;
    const localMatches = crc === e.crc && compressedSize === e.compressedSize && size === e.size;
    // With a data descriptor the local header may carry zeros (written before the data was known).
    if (!localMatches && !(hasDescriptor && localZero)) refuse(SAVE_ZIP_HEADER_MISMATCH_ERROR);
    const dataEnd = dataOffset + e.compressedSize;
    if (dataEnd > cdOffset) refuse(SAVE_ZIP_TRUNCATED_ERROR);
    // Where the next record must start pins the descriptor's length: 0 without one, else 12, or
    // 16 with its optional signature. (A zip64 descriptor is 20 / 24 and lands here as a mismatch.)
    const next = entries[i + 1]?.localOffset ?? cdOffset;
    const descriptorLen = next - dataEnd;
    if (!hasDescriptor) {
      if (descriptorLen !== 0) refuse(SAVE_ZIP_LAYOUT_ERROR);
    } else {
      let d = dataEnd;
      if (descriptorLen === 16) {
        if (view.getUint32(d, true) !== SIG_DATA_DESCRIPTOR) refuse(SAVE_ZIP_DATA_DESCRIPTOR_ERROR);
        d += 4;
      } else if (descriptorLen !== 12) {
        refuse(SAVE_ZIP_DATA_DESCRIPTOR_ERROR);
      }
      if (
        view.getUint32(d, true) !== e.crc ||
        view.getUint32(d + 4, true) !== e.compressedSize ||
        view.getUint32(d + 8, true) !== e.size
      ) {
        refuse(SAVE_ZIP_DATA_DESCRIPTOR_ERROR);
      }
    }
    if (e.method === METHOD_DEFLATE) {
      deflated.push({ dataOffset, compressedSize: e.compressedSize, size: e.size });
    }
    // For the last entry `next` is cdOffset, so the walk ends exactly where the directory starts.
    cursor = next;
  }

  return { ok: true, entryCount: entries.length, deflated };
}

/**
 * Validate a zip's structure, names and declared sizes. Synchronous and allocation-light (views
 * over the caller's buffer). The caller has already applied the byte cap
 * ({@link SAVE_ZIP_MAX_BYTES}). A pass still needs {@link verifySaveZipInflate} before the save.
 */
export function validateSaveZip(bytes: ArrayBuffer): SaveZipValidation {
  try {
    return validate(bytes);
  } catch (err) {
    if (err instanceof ZipRefusal) return { ok: false, error: err.message };
    // A RangeError from a DataView read past the end is a truncated archive, nothing else.
    if (err instanceof RangeError) return { ok: false, error: SAVE_ZIP_TRUNCATED_ERROR };
    throw err;
  }
}

/** Inflate one entry; true iff it yields exactly `size` bytes. Stops as soon as it yields more. */
async function inflatesToDeclaredSize(
  data: Uint8Array<ArrayBuffer>,
  size: number
): Promise<boolean> {
  const ds = new DecompressionStream('deflate-raw');
  const writer = ds.writable.getWriter();
  const reader = ds.readable.getReader();
  // Feed in slices so a bomb is caught after the first slice that overshoots, not after all of it.
  const CHUNK = 1024 * 1024;
  const feed = (async () => {
    for (let off = 0; off < data.length; off += CHUNK) {
      await writer.write(data.subarray(off, Math.min(off + CHUNK, data.length)));
    }
    await writer.close();
  })();
  feed.catch(() => undefined);
  let produced = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      produced += value.byteLength;
      if (produced > size) {
        await reader.cancel().catch(() => undefined);
        await writer.abort().catch(() => undefined);
        return false;
      }
    }
    await feed;
  } catch {
    return false;
  }
  return produced === size;
}

/**
 * Inflate every deflated entry {@link validateSaveZip} returned and refuse the zip unless each
 * yields exactly its declared size — so the declared-size bounds cannot be walked by lying about
 * them. Work is bounded by the declared total ({@link SAVE_ZIP_LIMITS}) plus one slice. Returns the
 * error string, or `null` when every entry checks out.
 */
export async function verifySaveZipInflate(
  bytes: ArrayBuffer,
  deflated: readonly SaveZipDeflatedEntry[]
): Promise<string | null> {
  const u8 = new Uint8Array(bytes);
  for (const e of deflated) {
    const data = u8.subarray(e.dataOffset, e.dataOffset + e.compressedSize);
    if (!(await inflatesToDeclaredSize(data, e.size))) return SAVE_ZIP_INFLATE_ERROR;
  }
  return null;
}
