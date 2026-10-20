import { GetObjectCommand } from '@aws-sdk/client-s3';
import { PassThrough, Readable } from 'stream';
import * as yauzl from 'yauzl';
import type { getS3Client } from '~/utils/s3-utils';

// Ranged reads of a remote zip, without downloading it. What a caller allows inside the archive is
// the caller's policy; this only reads it.

export type ZipSource = {
  size: number;
  /** A stream of bytes [start, end) of the archive. */
  readRange: (start: number, end: number) => Readable;
};

/** Storage failed, not the archive. Worth a retry, unless the object is gone. */
export class RangeReadError extends Error {
  constructor(message: string, readonly notFound = false) {
    super(message);
    this.name = 'RangeReadError';
  }
}

const asRangeReadError = (error: unknown) => {
  if (error instanceof RangeReadError) return error;
  const e = error as { name?: string; message?: string; $metadata?: { httpStatusCode?: number } };
  const notFound =
    e?.name === 'NoSuchKey' || e?.name === 'NotFound' || e?.$metadata?.httpStatusCode === 404;
  return new RangeReadError(e?.message ?? 'Range read failed', notFound);
};

/** The archive's structure is unreadable. */
export class InvalidZipError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidZipError';
  }
}

/** A zip held in memory: for tests, and for any caller that already has the bytes. */
export const bufferZipSource = (buffer: Buffer): ZipSource => ({
  size: buffer.byteLength,
  readRange: (start, end) => Readable.from([buffer.subarray(start, end)]),
});

/** Every failure, whether opening the read, mid-body or a body cut short, surfaces as a
 *  `RangeReadError`. */
const streamFrom = (start: number, end: number, open: () => Promise<Readable>) => {
  const out = new PassThrough();
  if (end <= start) {
    out.end();
    return out;
  }
  open()
    .then((body) => {
      let received = 0;
      body.on('data', (chunk: Buffer) => (received += chunk.length));
      body.on('error', (error) => out.destroy(asRangeReadError(error)));
      body.on('end', () =>
        received < end - start
          ? out.destroy(new RangeReadError('Range read ended early'))
          : out.end()
      );
      body.pipe(out, { end: false });
    })
    .catch((error) => out.destroy(asRangeReadError(error)));
  return out;
};

/** Ranged reads of an object in the bucket. */
export const s3ZipSource = (
  client: ReturnType<typeof getS3Client>,
  bucket: string,
  key: string,
  size: number,
  signal?: AbortSignal
): ZipSource => ({
  size,
  readRange: (start, end) => {
    // Storage answers a range past the end with what exists, which would read as cut short.
    const to = Math.min(end, size);
    return streamFrom(start, to, async () => {
      const response = await client.send(
        new GetObjectCommand({ Bucket: bucket, Key: key, Range: `bytes=${start}-${to - 1}` }),
        { abortSignal: signal }
      );
      const body = response.Body as Readable | undefined;
      if (!body) throw new Error('Empty object body');
      return body;
    });
  },
});

/** One read of the end covers the end-of-archive records and, usually, the whole file list. */
const TAIL_BYTES = 256 * 1024;

async function collect(stream: Readable) {
  const chunks: Buffer[] = [];
  for await (const chunk of stream as AsyncIterable<Buffer>) chunks.push(chunk);
  return Buffer.concat(chunks);
}

/**
 * yauzl reads each file-list record with its own small reads; served straight from storage that is
 * a request per read. Segments fetched ahead are served from memory instead; anything else is read
 * through.
 */
export class ZipRangeReader extends yauzl.RandomAccessReader {
  private readonly segments: Array<{ start: number; data: Buffer }> = [];
  constructor(private readonly source: ZipSource) {
    super();
  }
  cache(start: number, data: Buffer) {
    this.segments.push({ start, data });
  }
  /** Drops the segment fetched from `start`, once its reads are done. */
  evict(start: number) {
    const index = this.segments.findIndex((s) => s.start === start);
    if (index >= 0) this.segments.splice(index, 1);
  }
  async prefetch(start: number, end: number) {
    const to = Math.min(end, this.source.size);
    if (to > start) this.cache(start, await collect(this.source.readRange(start, to)));
  }
  _readStreamForRange(start: number, end: number) {
    const hit = this.segments.find((s) => start >= s.start && end <= s.start + s.data.length);
    if (hit) return Readable.from([hit.data.subarray(start - hit.start, end - hit.start)]);
    return this.source.readRange(start, end);
  }
}

export type ZipDirectory = { entries: number; offset: number; length: number };

function locateDirectory(tail: Buffer, size: number): ZipDirectory {
  const tailStart = size - tail.length;
  const eocd = tail.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (eocd < 0 || eocd + 22 > tail.length) throw new InvalidZipError('No end of central directory');
  let entries = tail.readUInt16LE(eocd + 10);
  let length = tail.readUInt32LE(eocd + 12);
  let offset = tail.readUInt32LE(eocd + 16);
  if (entries === 0xffff || length === 0xffffffff || offset === 0xffffffff) {
    const locator = eocd - 20;
    if (locator < 0 || tail.readUInt32LE(locator) !== 0x07064b50)
      throw new InvalidZipError('No zip64 locator');
    const record = Number(tail.readBigUInt64LE(locator + 8)) - tailStart;
    if (record < 0 || record + 56 > tail.length || tail.readUInt32LE(record) !== 0x06064b50)
      throw new InvalidZipError('No zip64 end of central directory');
    entries = Number(tail.readBigUInt64LE(record + 32));
    length = Number(tail.readBigUInt64LE(record + 40));
    offset = Number(tail.readBigUInt64LE(record + 48));
  }
  return { entries, offset, length };
}

/** A file list larger than this is read through rather than held in memory. */
const DIRECTORY_PREFETCH_MAX_BYTES = 4 * 1024 * 1024;

/**
 * Opens the archive with its file list in memory, so listing entries costs at most two reads.
 * `directory` is what the end record declares, for a caller's limits; the entry count can
 * understate the real one, so count entries as they arrive too. The caller closes `zipfile`.
 *
 * Throws `InvalidZipError` on a malformed archive; a storage failure propagates as thrown.
 */
export async function openRangeZip(
  source: ZipSource,
  options: { validateEntrySizes?: boolean } = {}
): Promise<{ zipfile: yauzl.ZipFile; reader: ZipRangeReader; directory: ZipDirectory }> {
  const tailLength = Math.min(TAIL_BYTES, source.size);
  const tail = await collect(source.readRange(source.size - tailLength, source.size));
  const tailStart = source.size - tail.length;
  const directory = locateDirectory(tail, source.size);

  const reader = new ZipRangeReader(source);
  reader.cache(tailStart, tail);
  if (directory.offset < tailStart && directory.length <= DIRECTORY_PREFETCH_MAX_BYTES)
    await reader.prefetch(directory.offset, directory.offset + directory.length);

  const zipfile = await new Promise<yauzl.ZipFile>((resolve, reject) =>
    yauzl.fromRandomAccessReader(
      reader,
      source.size,
      {
        lazyEntries: true,
        autoClose: false,
        validateEntrySizes: options.validateEntrySizes ?? true,
      },
      (error, zip) => {
        if (zip && !error) return resolve(zip);
        reject(error instanceof RangeReadError ? error : new InvalidZipError(error?.message ?? ''));
      }
    )
  );
  return { zipfile, reader, directory };
}
