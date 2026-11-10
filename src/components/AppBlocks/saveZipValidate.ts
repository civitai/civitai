/**
 * App Blocks `SAVE_IMAGE { bytes }` — the `.zip` validator. TEST-FIRST STUB: the contract
 * (limits and refusal strings) only; the validator itself lands in the next commit.
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

export type SaveZipDeflatedEntry = { dataOffset: number; compressedSize: number; size: number };

export type SaveZipValidation =
  | { ok: true; entryCount: number; deflated: SaveZipDeflatedEntry[] }
  | { ok: false; error: string };

export function looksLikeSaveZip(_u8: Uint8Array): boolean {
  throw new Error('not implemented');
}

export function validateSaveZip(_bytes: ArrayBuffer): SaveZipValidation {
  throw new Error('not implemented');
}

export async function verifySaveZipInflate(
  _bytes: ArrayBuffer,
  _deflated: readonly SaveZipDeflatedEntry[]
): Promise<string | null> {
  throw new Error('not implemented');
}
