import { GetObjectCommand } from '@aws-sdk/client-s3';
import { PassThrough, Readable, Transform } from 'stream';
import * as yauzl from 'yauzl';
import {
  SERVICE_ZIP_ARCHIVE_EXTENSIONS,
  SERVICE_ZIP_IMAGE_EXTENSIONS,
  SERVICE_ZIP_MAX_ENTRIES,
  SERVICE_ZIP_MAX_ENTRY_BYTES,
  SERVICE_ZIP_MAX_IMAGE_BYTES,
  SERVICE_ZIP_MAX_RATIO,
  SERVICE_ZIP_MAX_TOTAL_BYTES,
  SERVICE_ZIP_MODEL_EXTENSIONS,
  SERVICE_ZIP_RATIO_FLOOR_BYTES,
  SERVICE_ZIP_VIDEO_EXTENSIONS,
} from '~/shared/constants/creator-services.constants';
import type { getS3Client } from '~/utils/s3-utils';

/**
 * Reads a zip Final without ever holding more than one entry: the central directory is read with
 * ranged GETs, then each entry is inflated as a stream. Nothing touches disk.
 *
 * Every limit is enforced on the bytes actually inflated, not on the sizes an entry declares, so an
 * archive that lies about itself is stopped by what it really does. A refusal carries a message the
 * seller can act on and says nothing about how files are judged.
 */

/** The seller can fix this by delivering something else; the message goes back to them as it is. */
export class ZipRejectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ZipRejectedError';
  }
}

export type ZipSource = {
  size: number;
  /** A stream of bytes [start, end) of the archive. */
  readRange: (start: number, end: number) => Readable;
};

/** A zip held in memory: for tests, and for any caller that already has the bytes. */
export const bufferZipSource = (buffer: Buffer): ZipSource => ({
  size: buffer.byteLength,
  readRange: (start, end) => Readable.from([buffer.subarray(start, end)]),
});

/** Ranged reads of an object in the bucket. */
export const s3ZipSource = (
  client: ReturnType<typeof getS3Client>,
  bucket: string,
  key: string,
  size: number
): ZipSource => ({
  size,
  readRange: (start, end) => {
    const out = new PassThrough();
    if (end <= start) {
      out.end();
      return out;
    }
    client
      .send(new GetObjectCommand({ Bucket: bucket, Key: key, Range: `bytes=${start}-${end - 1}` }))
      .then((response) => {
        const body = response.Body as Readable | undefined;
        if (!body) throw new Error('Empty object body');
        body.on('error', (error) => out.destroy(error));
        body.pipe(out);
      })
      .catch((error) => out.destroy(error));
    return out;
  },
});

class SourceReader extends yauzl.RandomAccessReader {
  constructor(private readonly source: ZipSource) {
    super();
  }
  _readStreamForRange(start: number, end: number) {
    return this.source.readRange(start, end);
  }
}

const VIDEO_REFUSAL = 'Video cannot be delivered yet.';
const NESTED_REFUSAL = 'Archives cannot be nested inside the .zip. Put the files in it directly.';
const IMAGE_FORMAT_REFUSAL = 'This image format cannot be delivered. Use PNG, JPEG, WebP or GIF.';
const TOO_LARGE_REFUSAL = 'A file in the archive is too large.';
const RATIO_REFUSAL = 'A file in the archive is compressed beyond what is allowed.';

const ABSOLUTE_PATH_REFUSAL = 'The archive contains files with absolute paths.';
const OUTSIDE_PATH_REFUSAL = 'The archive contains files that point outside the archive.';

const extensionOf = (path: string) => {
  const name = path.split('/').pop() ?? '';
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
};
const isIn = (list: readonly string[], value: string) => list.includes(value);

/** Image formats we cannot make a scan copy of. Refused rather than passed unseen. */
const UNSCANNABLE_IMAGE_EXTENSIONS = [
  'bmp',
  'tif',
  'tiff',
  'avif',
  'heic',
  'heif',
  'svg',
  'ico',
  'psd',
  'jxl',
] as const;

/** Why a path cannot be unpacked safely, or null. Backslashes count as separators. */
export function pathRefusal(rawPath: string) {
  const path = rawPath.replace(/\\/g, '/');
  if (path.includes('\0') || path.length > 512) return 'A file in the archive has an invalid name.';
  if (path.startsWith('/') || /^[a-zA-Z]:/.test(path)) return ABSOLUTE_PATH_REFUSAL;
  if (path.split('/').includes('..')) return OUTSIDE_PATH_REFUSAL;
  return null;
}

/** Entry-level refusals from the header alone. */
export function entryRefusal(
  entry: {
    fileName: string;
    compressedSize: number;
    uncompressedSize: number;
    compressionMethod: number;
    externalFileAttributes: number;
    isEncrypted: () => boolean;
  },
  { checkRatio = true } = {}
) {
  const bad = pathRefusal(entry.fileName);
  if (bad) return bad;
  if (entry.isEncrypted()) return 'Password-protected archives cannot be delivered.';
  // The unix file type sits in the top bits of the attributes: 0o120000 is a symbolic link.
  if (((entry.externalFileAttributes >>> 16) & 0o170000) === 0o120000)
    return 'The archive contains symbolic links.';
  if (entry.compressionMethod !== 0 && entry.compressionMethod !== 8)
    return 'The archive uses a compression method that is not supported.';

  const extension = extensionOf(entry.fileName);
  if (isIn(SERVICE_ZIP_ARCHIVE_EXTENSIONS, extension)) return NESTED_REFUSAL;
  if (isIn(SERVICE_ZIP_MODEL_EXTENSIONS, extension))
    return 'Model files cannot be inside a .zip. Deliver each as its own file.';
  if (isIn(SERVICE_ZIP_VIDEO_EXTENSIONS, extension)) return VIDEO_REFUSAL;
  if (isIn(UNSCANNABLE_IMAGE_EXTENSIONS, extension)) return IMAGE_FORMAT_REFUSAL;

  const cap = isIn(SERVICE_ZIP_IMAGE_EXTENSIONS, extension)
    ? SERVICE_ZIP_MAX_IMAGE_BYTES
    : SERVICE_ZIP_MAX_ENTRY_BYTES;
  if (entry.uncompressedSize > cap) return TOO_LARGE_REFUSAL;
  if (
    checkRatio &&
    entry.uncompressedSize > SERVICE_ZIP_RATIO_FLOOR_BYTES &&
    entry.uncompressedSize > entry.compressedSize * SERVICE_ZIP_MAX_RATIO
  )
    return RATIO_REFUSAL;
  return null;
}

export type EntryKind = 'image' | 'other';

/** What the first bytes of an entry are, whatever its name says. */
export function sniffEntry(head: Buffer): EntryKind | 'video' | 'archive' | 'unscannable' {
  const at = (offset: number, text: string) =>
    head.subarray(offset, offset + text.length).toString('latin1') === text;
  const bytes = (...values: number[]) => values.every((value, i) => head[i] === value);
  if (
    bytes(0xff, 0xd8, 0xff) ||
    bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a) ||
    at(0, 'GIF8')
  )
    return 'image';
  if (at(0, 'RIFF') && at(8, 'WEBP')) return 'image';
  if (at(0, 'RIFF') && at(8, 'AVI ')) return 'video';
  if (
    at(4, 'ftyp') ||
    bytes(0x1a, 0x45, 0xdf, 0xa3) ||
    bytes(0x46, 0x4c, 0x56, 1) ||
    bytes(0, 0, 1, 0xba) ||
    bytes(0, 0, 1, 0xb3)
  )
    return 'video';
  if (
    bytes(0x50, 0x4b, 3, 4) ||
    bytes(0x50, 0x4b, 5, 6) ||
    bytes(0x50, 0x4b, 7, 8) ||
    at(0, 'Rar!') ||
    bytes(0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c) ||
    bytes(0x1f, 0x8b) ||
    (at(0, 'BZh') && head[3] >= 0x31 && head[3] <= 0x39) ||
    bytes(0xfd, 0x37, 0x7a, 0x58, 0x5a, 0) ||
    bytes(0x28, 0xb5, 0x2f, 0xfd)
  )
    return 'archive';
  if (
    (at(0, 'BM') && head[6] === 0 && head[7] === 0 && head[8] === 0 && head[9] === 0) ||
    at(0, 'II*\0') ||
    at(0, 'MM\0*') ||
    at(0, '8BPS') ||
    bytes(0, 0, 1, 0)
  )
    return 'unscannable';
  return 'other';
}

const SNIFF_BYTES = 16;

export type ZipEntry = {
  /** Position among the archive's entries; stable between reads of the same archive. */
  index: number;
  path: string;
  size: number;
  /** The yauzl entry, for reading. */
  raw: yauzl.Entry;
};

export type OpenedZip = { zipfile: yauzl.ZipFile; entries: ZipEntry[] };

/** yauzl's own path checks fire before an entry reaches ours; they get the same words. */
function yauzlRefusal(error: Error) {
  if (error instanceof ZipRejectedError) return error;
  if (/absolute path/.test(error.message)) return new ZipRejectedError(ABSOLUTE_PATH_REFUSAL);
  if (/relative path/.test(error.message)) return new ZipRejectedError(OUTSIDE_PATH_REFUSAL);
  return new ZipRejectedError('This is not a valid .zip file.');
}

const openArchive = (source: ZipSource) =>
  new Promise<yauzl.ZipFile>((resolve, reject) => {
    yauzl.fromRandomAccessReader(
      new SourceReader(source),
      source.size,
      {
        lazyEntries: true,
        autoClose: false,
        // Off on purpose: yauzl would otherwise trust the declared size to bound what it inflates.
        // The reader below counts what actually comes out and enforces every limit on that.
        validateEntrySizes: false,
      },
      (error, zipfile) =>
        error || !zipfile
          ? reject(new ZipRejectedError('This is not a valid .zip file.'))
          : resolve(zipfile)
    );
  });

/**
 * Opens the archive and reads its directory, refusing it on anything the headers already show.
 * The caller closes `zipfile`.
 */
export async function openZip(source: ZipSource, { checkRatio = true } = {}): Promise<OpenedZip> {
  const zipfile = await openArchive(source);
  try {
    const entries: ZipEntry[] = [];
    let declaredTotal = 0;
    let seen = 0;
    await new Promise<void>((resolve, reject) => {
      zipfile.on('error', (error) => reject(yauzlRefusal(error)));
      zipfile.on('end', () => resolve());
      zipfile.on('entry', (entry: yauzl.Entry) => {
        try {
          // The count in the directory header can understate the real number of entries.
          if (++seen > SERVICE_ZIP_MAX_ENTRIES)
            throw new ZipRejectedError(
              `The archive has too many files (max ${SERVICE_ZIP_MAX_ENTRIES}).`
            );
          const refusal = entryRefusal(entry, { checkRatio });
          if (refusal) throw new ZipRejectedError(refusal);
          if (!entry.fileName.endsWith('/')) {
            declaredTotal += entry.uncompressedSize;
            if (declaredTotal > SERVICE_ZIP_MAX_TOTAL_BYTES)
              throw new ZipRejectedError('The archive is too large once unpacked.');
            entries.push({
              index: seen - 1,
              path: entry.fileName.replace(/\\/g, '/'),
              size: entry.uncompressedSize,
              raw: entry,
            });
          }
          zipfile.readEntry();
        } catch (error) {
          reject(error);
        }
      });
      zipfile.readEntry();
    });
    return { zipfile, entries };
  } catch (error) {
    zipfile.close();
    throw error;
  }
}

export type EntryRead = {
  kind: EntryKind;
  /** The bytes actually inflated. */
  bytes: number;
  /** Present only when the caller asked to keep this kind. */
  data: Buffer | null;
};

/**
 * Inflates one entry, counting what actually comes out. The stream is cut the moment a limit is
 * crossed, whatever the header claimed. `budget.used` carries the archive-wide total across entries.
 */
export async function readEntry(
  zipfile: yauzl.ZipFile,
  entry: ZipEntry,
  budget: { used: number },
  keep: (kind: EntryKind) => boolean
): Promise<EntryRead> {
  const stream = await new Promise<Readable>((resolve, reject) =>
    zipfile.openReadStream(entry.raw, (error, readable) =>
      error || !readable
        ? reject(new ZipRejectedError('A file in the archive could not be read.'))
        : resolve(readable)
    )
  );
  const compressed = Math.max(1, entry.raw.compressedSize);
  const declaredImage = isIn(SERVICE_ZIP_IMAGE_EXTENSIONS, extensionOf(entry.path));
  const chunks: Buffer[] = [];
  const head: Buffer[] = [];
  let headLength = 0;
  let kind: EntryKind | null = null;
  let bytes = 0;

  /** The entry's kind from its first bytes, refusing what must not be in a final. */
  const decide = (): EntryKind => {
    const sniffed = sniffEntry(Buffer.concat(head));
    if (sniffed === 'video') throw new ZipRejectedError(VIDEO_REFUSAL);
    if (sniffed === 'archive') throw new ZipRejectedError(NESTED_REFUSAL);
    if (sniffed === 'unscannable') throw new ZipRejectedError(IMAGE_FORMAT_REFUSAL);
    // A file named like an image that is not one is refused rather than judged by its name.
    if (declaredImage && sniffed !== 'image')
      throw new ZipRejectedError('A file in the archive is not the image its name says.');
    return sniffed;
  };

  try {
    for await (const chunk of stream as AsyncIterable<Buffer>) {
      bytes += chunk.byteLength;
      budget.used += chunk.byteLength;
      if (budget.used > SERVICE_ZIP_MAX_TOTAL_BYTES)
        throw new ZipRejectedError('The archive is too large once unpacked.');
      if (bytes > SERVICE_ZIP_MAX_ENTRY_BYTES) throw new ZipRejectedError(TOO_LARGE_REFUSAL);
      if (bytes > SERVICE_ZIP_RATIO_FLOOR_BYTES && bytes > compressed * SERVICE_ZIP_MAX_RATIO)
        throw new ZipRejectedError(RATIO_REFUSAL);
      if (kind === 'image' && bytes > SERVICE_ZIP_MAX_IMAGE_BYTES)
        throw new ZipRejectedError(TOO_LARGE_REFUSAL);

      if (kind) {
        if (keep(kind)) chunks.push(chunk);
        continue;
      }
      head.push(chunk);
      headLength += chunk.byteLength;
      if (headLength < SNIFF_BYTES) continue;
      kind = decide();
      // The chunk that settled the kind may itself be the whole entry.
      if (kind === 'image' && bytes > SERVICE_ZIP_MAX_IMAGE_BYTES)
        throw new ZipRejectedError(TOO_LARGE_REFUSAL);
      if (keep(kind)) chunks.push(Buffer.concat(head));
    }
    if (!kind) {
      // Shorter than the sniffed head: still judged, on what there is.
      kind = decide();
      if (keep(kind)) chunks.push(Buffer.concat(head));
    }
  } catch (error) {
    stream.destroy();
    if (error instanceof ZipRejectedError) throw error;
    // Data that does not inflate is the archive's fault. Anything else (a dropped connection) is
    // not, and is retried.
    if (((error as { code?: string })?.code ?? '').startsWith('Z_'))
      throw new ZipRejectedError('The archive is damaged.');
    throw error;
  }

  return { kind, bytes, data: keep(kind) ? Buffer.concat(chunks) : null };
}

/**
 * Counts what passes through an entry being copied and cuts it the moment a limit is crossed, on the
 * same terms as `readEntry`.
 */
class LimitedEntry extends Transform {
  private bytes = 0;
  constructor(
    private readonly compressed: number,
    private readonly cap: number,
    private readonly budget: { used: number }
  ) {
    super();
  }
  _transform(
    chunk: Buffer,
    _encoding: BufferEncoding,
    done: (error?: Error | null, data?: Buffer) => void
  ) {
    this.bytes += chunk.byteLength;
    this.budget.used += chunk.byteLength;
    if (this.budget.used > SERVICE_ZIP_MAX_TOTAL_BYTES)
      return done(new ZipRejectedError('The archive is too large once unpacked.'));
    if (this.bytes > this.cap) return done(new ZipRejectedError(TOO_LARGE_REFUSAL));
    if (
      this.bytes > SERVICE_ZIP_RATIO_FLOOR_BYTES &&
      this.bytes > this.compressed * SERVICE_ZIP_MAX_RATIO
    )
      return done(new ZipRejectedError(RATIO_REFUSAL));
    done(null, chunk);
  }
}

/** An entry's bytes as a stream, for copying into an archive the server builds. */
export async function openEntryStream(
  zipfile: yauzl.ZipFile,
  entry: ZipEntry,
  budget: { used: number }
): Promise<Readable> {
  const source = await new Promise<Readable>((resolve, reject) =>
    zipfile.openReadStream(entry.raw, (error, readable) =>
      error || !readable
        ? reject(new ZipRejectedError('A file in the archive could not be read.'))
        : resolve(readable)
    )
  );
  const cap = isIn(SERVICE_ZIP_IMAGE_EXTENSIONS, extensionOf(entry.path))
    ? SERVICE_ZIP_MAX_IMAGE_BYTES
    : SERVICE_ZIP_MAX_ENTRY_BYTES;
  const limited = new LimitedEntry(Math.max(1, entry.raw.compressedSize), cap, budget);
  source.on('error', (error) => limited.destroy(error));
  limited.on('close', () => source.destroy());
  return source.pipe(limited);
}

/**
 * The name an entry has in the archive the server builds: the checked path, tidied. Throws when
 * nothing usable is left, so a file can never be built under a name that was not checked.
 */
export function deliveryName(path: string) {
  const name = path
    .normalize('NFC')
    .replace(/\\/g, '/')
    .replace(/\/{2,}/g, '/')
    .replace(/^(\.\/)+/, '');
  if (!name || name.endsWith('/') || pathRefusal(name))
    throw new ZipRejectedError('A file in the archive has an invalid name.');
  return name;
}
