import { GetObjectCommand } from '@aws-sdk/client-s3';
import pLimit from 'p-limit';
import { PassThrough, Readable, Transform } from 'stream';
import * as yauzl from 'yauzl';
import { createInflateRaw } from 'zlib';
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
  SERVICE_FINAL_PDF_REFUSAL,
  SERVICE_FINAL_VIDEO_IN_ZIP,
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
        // A reader that stops early destroys `out`; the body must go too, or its socket stays held.
        if (out.destroyed) return body.destroy();
        out.once('close', () => body.destroy());
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

const VIDEO_REFUSAL = SERVICE_FINAL_VIDEO_IN_ZIP;
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

/** Whether a path is named as a picture, a video or an archive, whatever its bytes are. */
export const isMediaName = (path: string) => {
  const extension = extensionOf(path);
  return [
    SERVICE_ZIP_IMAGE_EXTENSIONS,
    UNSCANNABLE_IMAGE_EXTENSIONS,
    SERVICE_ZIP_VIDEO_EXTENSIONS,
    SERVICE_ZIP_ARCHIVE_EXTENSIONS,
  ].some((list) => isIn(list, extension));
};

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
  if (extension === 'pdf') return SERVICE_FINAL_PDF_REFUSAL;

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

/** How far into a file a player hunts for a transport stream's sync byte. */
const TS_SEARCH_BYTES = 1024;

/**
 * Four packets in a row of a transport stream (188 bytes; 192 with a timecode, 204 with error
 * correction), starting anywhere in the first KiB: a player hunts for the sync, so junk before it
 * does not hide the stream.
 */
function isMpegTs(head: Buffer, anywhere: boolean) {
  const starts = anywhere ? Array.from({ length: TS_SEARCH_BYTES }, (_, i) => i) : [0, 4];
  return [188, 192, 204].some((packet) =>
    starts.some(
      (start) =>
        start + 3 * packet < head.length &&
        [0, 1, 2, 3].every((i) => head[start + i * packet] === 0x47)
    )
  );
}

/** Leading ID3v2 tags read past; a file with more is refused, since what follows is unread. */
export const MAX_ID3_TAGS = 8;

/**
 * The length of the ID3v2 tag `head` opens with (header, body and footer), or 0 if it opens with
 * none. A player skips the tag and plays whatever follows it, whatever that is.
 */
export function id3TagLength(head: Buffer) {
  if (head.length < 10 || head.subarray(0, 3).toString('latin1') !== 'ID3') return 0;
  if (head[3] === 0xff || head[4] === 0xff) return 0;
  const size = head.subarray(6, 10);
  if (size.some((byte) => byte >= 0x80)) return 0;
  const body = (size[0] << 21) | (size[1] << 14) | (size[2] << 7) | size[3];
  return 10 + body + (head[5] & 0x10 ? 10 : 0);
}

/** Collects a stream's first `SNIFF_BYTES` past its leading ID3v2 tags, as a player would read it. */
class SniffedHead {
  private parts: Buffer[] = [];
  private length = 0;
  private skip = 0;
  /** At the start of what follows the tags so far, where another tag could begin. */
  private atTagStart = true;
  tags = 0;

  /** Whether enough has been read to judge. */
  push(chunk: Buffer) {
    while (chunk.length) {
      if (this.skip) {
        const skipped = Math.min(this.skip, chunk.length);
        this.skip -= skipped;
        chunk = chunk.subarray(skipped);
        continue;
      }
      this.parts.push(chunk);
      this.length += chunk.length;
      chunk = Buffer.alloc(0);
      if (!this.atTagStart || this.length < 10) continue;
      const bytes = this.bytes();
      const tag = this.tags < MAX_ID3_TAGS ? id3TagLength(bytes) : 0;
      if (!tag) {
        this.atTagStart = false;
        continue;
      }
      this.tags++;
      this.parts = [];
      this.length = 0;
      this.skip = tag;
      chunk = bytes;
    }
    return this.length >= SNIFF_BYTES;
  }

  bytes() {
    return Buffer.concat(this.parts);
  }
}

const OGG_AUDIO = ['\x01vorbis', 'OpusHead', '\x7fFLAC', 'Speex   '];

/**
 * Whether every stream an Ogg file opens with is a sound codec. Its streams are declared in the
 * first pages (each marked beginning-of-stream); anything else there, or pages running past the
 * bytes read, is not taken as sound.
 */
function isOggAudio(head: Buffer) {
  let offset = 0;
  let streams = 0;
  // Every page in the bytes read, not only the first: a stream can be opened after another's headers.
  while (offset + 27 <= head.length) {
    // Bytes between pages are skipped by a player, which resyncs on the next page.
    if (head.subarray(offset, offset + 4).toString('latin1') !== 'OggS') return false;
    const segments = head[offset + 26];
    const data = offset + 27 + segments;
    if (data > head.length) break;
    let length = 0;
    for (let i = 0; i < segments; i++) length += head[offset + 27 + i];
    if (head[offset + 5] & 0x02) {
      if (data + 8 > head.length) return false;
      const packet = head.subarray(data, data + 8).toString('latin1');
      if (!OGG_AUDIO.some((magic) => packet.startsWith(magic))) return false;
      streams++;
    }
    offset = data + length;
  }
  return streams > 0;
}

const PDF_HEADER = Buffer.from('%PDF-');
const PDF_HEADER_WINDOW = 1024;

/** What the first bytes of an entry are, whatever its name says. */
/**
 * `tsAnywhere: false` looks for a transport stream only where a file of one starts (byte 0, or 4
 * with a timecode), for bytes that are not a file of their own, such as a checkpoint's tensors.
 */
export function sniffEntry(
  head: Buffer,
  { tsAnywhere = true } = {}
): EntryKind | 'video' | 'archive' | 'unscannable' | 'pdf' {
  const at = (offset: number, text: string) =>
    head.subarray(offset, offset + text.length).toString('latin1') === text;
  const bytes = (...values: number[]) => values.every((value, i) => head[i] === value);
  // Ahead of the rest: a reader finds the header anywhere in the first 1 KB.
  if (head.subarray(0, PDF_HEADER_WINDOW).includes(PDF_HEADER)) return 'pdf';
  // Ahead of the image signatures: a player finds the stream behind any header.
  if (isMpegTs(head, tsAnywhere) || id3TagLength(head)) return 'video';
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
    (at(0, 'OggS') && !isOggAudio(head)) ||
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
    bytes(0x1f, 0x8b, 0x08) ||
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

/** Enough for a transport stream found anywhere in its first KiB, and an Ogg file's first pages. */
export const SNIFF_BYTES = 64 * 1024;

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

/** Every entry in an archive's directory, refusing one of more than `max`. */
function directoryOf(zipfile: yauzl.ZipFile, max: number) {
  const entries: yauzl.Entry[] = [];
  return new Promise<yauzl.Entry[]>((resolve, reject) => {
    zipfile.on('error', (error) => reject(yauzlRefusal(error)));
    zipfile.on('end', () => resolve(entries));
    zipfile.on('entry', (entry: yauzl.Entry) => {
      if (entries.push(entry) > max)
        return reject(new ZipRejectedError('The archive has too many files.'));
      zipfile.readEntry();
    });
    zipfile.readEntry();
  });
}

/** The paths in an archive's directory, nothing read but the directory. */
export async function listZipPaths(source: ZipSource, max: number) {
  const zipfile = await openArchive(source);
  try {
    return (await directoryOf(zipfile, max)).map((entry) => entry.fileName);
  } finally {
    zipfile.close();
  }
}

const ENTRY_HEAD_READS = 8;
const DATA_DESCRIPTOR = 0x08;
const UNICODE_PATH_FIELD = 0x7075;
const ZIP64_FIELD = 0x0001;
const DESCRIPTOR_SIGNATURE = 0x08074b50;

/** The data of the extra field `id`, if `extra` has one. */
const extraField = (extra: Buffer, id: number) => {
  for (let at = 0; at + 4 <= extra.length; at += 4 + extra.readUInt16LE(at + 2))
    if (extra.readUInt16LE(at) === id)
      return extra.subarray(at + 4, at + 4 + extra.readUInt16LE(at + 2));
  return null;
};

async function readBytes(source: ZipSource, start: number, end: number) {
  const chunks: Buffer[] = [];
  for await (const chunk of source.readRange(start, end) as AsyncIterable<Buffer>)
    chunks.push(chunk);
  return Buffer.concat(chunks);
}

/** A local header's sizes, from its zip64 field where the header defers to one. */
function localSizes(local: yauzl.LocalFileHeader) {
  const zip64 = extraField(local.extraField, ZIP64_FIELD);
  let { compressedSize: compressed, uncompressedSize: uncompressed } = local;
  if (zip64 && (compressed === 0xffffffff || uncompressed === 0xffffffff)) {
    if (zip64.length < 16) return null;
    uncompressed = Number(zip64.readBigUInt64LE(0));
    compressed = Number(zip64.readBigUInt64LE(8));
  }
  return { compressed, uncompressed, zip64: !!zip64 };
}

/**
 * Whether every file entry's first bytes (past any ID3v2 tags) pass `accept`, for an archive that
 * is delivered as it is rather than unpacked. Refuses an archive whose local headers say anything
 * other than its directory does, or whose entries do not fill it end to end: an extractor that
 * streams the archive goes by the local headers, and could find an entry the directory hides.
 */
export async function everyEntryHead(
  source: ZipSource,
  max: number,
  accept: (path: string, head: Buffer) => boolean
) {
  const zipfile = await openArchive(source);
  // yauzl keeps where the directory starts as its read cursor until the first entry is read.
  const directoryStart = (zipfile as unknown as { readEntryCursor: number }).readEntryCursor;
  const mismatch = () =>
    new ZipRejectedError('A file in the archive is described differently in its headers.');
  try {
    const entries = await directoryOf(zipfile, max);
    let failed = false;
    let inflatedTotal = 0;
    const limit = pLimit(ENTRY_HEAD_READS);
    const reads = entries.map((entry) =>
      limit(async () => {
        // The first refusal settles it; the reads still queued would only find the archive closed.
        if (failed) return null;
        if (entry.isEncrypted())
          throw new ZipRejectedError('Password-protected archives cannot be delivered.');
        if (entry.compressionMethod !== 0 && entry.compressionMethod !== 8)
          throw new ZipRejectedError(
            'The archive uses a compression method that is not supported.'
          );
        const local = await zipfile.readLocalFileHeaderPromise(entry).catch(() => {
          throw new ZipRejectedError('This is not a valid .zip file.');
        });
        if (
          !local.fileName.equals(entry.fileNameRaw) ||
          local.compressionMethod !== entry.compressionMethod ||
          local.generalPurposeBitFlag !== entry.generalPurposeBitFlag ||
          extraField(local.extraField, UNICODE_PATH_FIELD) ||
          entry.extraFields.some(({ id }) => id === UNICODE_PATH_FIELD)
        )
          throw mismatch();
        // The local header must give the directory's sizes and checksum, or, with a data
        // descriptor, leave them to it: an extractor that walks the local headers goes by these.
        const sizes = localSizes(local);
        const deferred = (entry.generalPurposeBitFlag & DATA_DESCRIPTOR) !== 0;
        const stated =
          sizes?.compressed === entry.compressedSize &&
          sizes.uncompressed === entry.uncompressedSize &&
          local.crc32 === entry.crc32;
        const left = sizes?.compressed === 0 && sizes.uncompressed === 0 && local.crc32 === 0;
        if (!sizes || !(stated || (deferred && left))) throw mismatch();
        const dataEnd = local.fileDataStart + entry.compressedSize;
        let end = dataEnd;
        if (deferred) {
          const descriptor = await readBytes(
            source,
            dataEnd,
            Math.min(dataEnd + 24, directoryStart)
          );
          const at =
            descriptor.length >= 4 && descriptor.readUInt32LE(0) === DESCRIPTOR_SIGNATURE ? 4 : 0;
          const length = at + (sizes.zip64 ? 20 : 12);
          if (descriptor.length < length) throw mismatch();
          const size = (offset: number) =>
            sizes.zip64
              ? Number(descriptor.readBigUInt64LE(offset))
              : descriptor.readUInt32LE(offset);
          if (
            descriptor.readUInt32LE(at) !== entry.crc32 ||
            size(at + 4) !== entry.compressedSize ||
            size(at + (sizes.zip64 ? 12 : 8)) !== entry.uncompressedSize
          )
            throw mismatch();
          end += length;
        }
        const span = { start: entry.relativeOffsetOfLocalHeader, end };
        if (entry.fileName.endsWith('/')) return span;
        // A deflated entry that defers its sizes ends where its stream does, so all of it is
        // inflated: the stream must end exactly where the directory says the data does.
        const whole = deferred && entry.compressionMethod === 8;
        // The callback form: yauzl 3.4's promise form of this call opens the entry by its header again.
        const data = await new Promise<Readable>((resolve, reject) =>
          zipfile.openReadStreamLowLevel(
            local.fileDataStart,
            entry.compressedSize,
            0,
            entry.compressedSize,
            entry.compressionMethod === 8 && !whole,
            null,
            (error, readable) =>
              error
                ? reject(new ZipRejectedError('This is not a valid .zip file.'))
                : resolve(readable)
          )
        );
        const inflate = whole ? createInflateRaw() : null;
        const stream = inflate ? data.pipe(inflate) : data;
        data.on('error', (error) => inflate?.destroy(error));
        const head = new SniffedHead();
        let enough = false;
        let inflated = 0;
        try {
          for await (const chunk of stream as AsyncIterable<Buffer>) {
            if (!enough) enough = head.push(chunk);
            if (!inflate) {
              if (enough) break;
            } else {
              // The same limits an unpacked archive's entries are held to, across the whole archive.
              inflated += chunk.length;
              inflatedTotal += chunk.length;
              if (inflatedTotal > SERVICE_ZIP_MAX_TOTAL_BYTES)
                throw new ZipRejectedError('The archive is too large once unpacked.');
              if (inflated > SERVICE_ZIP_MAX_ENTRY_BYTES)
                throw new ZipRejectedError(TOO_LARGE_REFUSAL);
              if (
                inflated > SERVICE_ZIP_RATIO_FLOOR_BYTES &&
                inflated > Math.max(1, entry.compressedSize) * SERVICE_ZIP_MAX_RATIO
              )
                throw new ZipRejectedError(RATIO_REFUSAL);
            }
          }
        } catch (error) {
          if (((error as { code?: string })?.code ?? '').startsWith('Z_'))
            throw new ZipRejectedError('The archive is damaged.');
          throw error;
        } finally {
          data.destroy();
          inflate?.destroy();
        }
        if (inflate && inflate.bytesWritten !== entry.compressedSize) throw mismatch();
        if (!accept(entry.fileName, head.bytes())) throw new EntryNotAccepted();
        return span;
      }).catch((error) => {
        failed = true;
        throw error;
      })
    );
    let spans;
    try {
      spans = await Promise.all(reads);
    } catch (error) {
      if (error instanceof EntryNotAccepted) return false;
      throw error;
    }
    // Entry after entry (each with its data descriptor, if it has one) from the first byte to the
    // directory, with nothing between them.
    let at = 0;
    for (const span of spans.filter((s) => s !== null).sort((a, b) => a.start - b.start)) {
      if (span.start !== at) throw mismatch();
      at = span.end;
    }
    if (at !== directoryStart) throw mismatch();
    return true;
  } finally {
    zipfile.close();
  }
}

class EntryNotAccepted extends Error {}

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
  /** The entry's bytes as stored, kept for an image until its kind is known. */
  const head: Buffer[] = [];
  const sniffed = new SniffedHead();
  let kind: EntryKind | null = null;
  let bytes = 0;

  /** The entry's kind from its first bytes, refusing what must not be in a final. */
  const decide = (): EntryKind => {
    const found = sniffEntry(sniffed.bytes());
    if (found === 'video') throw new ZipRejectedError(VIDEO_REFUSAL);
    if (found === 'archive') throw new ZipRejectedError(NESTED_REFUSAL);
    if (found === 'unscannable') throw new ZipRejectedError(IMAGE_FORMAT_REFUSAL);
    if (found === 'pdf') throw new ZipRejectedError(SERVICE_FINAL_PDF_REFUSAL);
    // A file named like an image that is not one is refused rather than judged by its name. An
    // image behind a tag is not one either: what is scanned must be the bytes as delivered.
    if ((declaredImage && found !== 'image') || (found === 'image' && sniffed.tags))
      throw new ZipRejectedError('A file in the archive is not the image its name says.');
    return found;
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
      // Past a tag, the entry can no longer be a kept image, so its bytes need not be held.
      if (!sniffed.tags) head.push(chunk);
      if (!sniffed.push(chunk)) continue;
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
