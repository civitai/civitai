import fs from 'fs';
import path from 'path';
import { Readable, Transform } from 'stream';
import { pipeline } from 'stream/promises';
import type { ReadableStream as NodeReadableStream } from 'stream/web';
import * as yauzl from 'yauzl';
import { MAX_EVIDENCE_BYTES } from '~/server/services/generator-evidence/preserve-blob';
import { isTrainingMediaEntry } from '~/utils/training';

/**
 * A send whose files come from a URL or a zip writes each one to disk as it streams in, so a file is
 * held in memory only while it is uploaded, one at a time. Bytes are counted as they arrive or
 * inflate, never as a header declares.
 */
export const MAX_SPOOL_BYTES_PER_REPORT = 1024 ** 3;
export const MAX_SPOOL_FILE_BYTES = MAX_EVIDENCE_BYTES;
/** A downloaded archive is one file on disk, never read whole: only what it inflates to is sent. */
export const MAX_ARCHIVE_BYTES = 4 * 1024 ** 3;
export const MAX_SPOOL_ENTRIES_PER_REPORT = 2_000;

export class SpoolLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SpoolLimitError';
  }
}

export type SkippedEntry = { name: string; reason: 'empty' | 'unreadable'; error?: string };
export type SpoolBudget = {
  used: number;
  readonly cap: number;
  readonly fileCap: number;
  /** Media entries met across the report's archives, sent or skipped. */
  entries: number;
  skipped: SkippedEntry[];
};
export const spoolBudget = (
  cap = MAX_SPOOL_BYTES_PER_REPORT,
  fileCap = Math.min(cap, MAX_SPOOL_FILE_BYTES)
): SpoolBudget => ({ used: 0, cap, fileCap, entries: 0, skipped: [] });

/** What a report's details record of the entries its send skipped, or undefined for none. */
export function skippedEntries({ skipped }: SpoolBudget) {
  if (!skipped.length) return;
  return {
    count: skipped.length,
    empty: skipped.filter(({ reason }) => reason === 'empty').length,
    unreadable: skipped.filter(({ reason }) => reason === 'unreadable').length,
    examples: skipped.slice(0, 10),
  };
}

export type SpooledFile = { path: string; filename: string; type: string };

class Counted extends Transform {
  private bytes = 0;
  constructor(private readonly budget: SpoolBudget) {
    super();
  }
  _transform(chunk: Buffer, _encoding: BufferEncoding, done: (error?: Error | null) => void) {
    this.bytes += chunk.byteLength;
    this.budget.used += chunk.byteLength;
    if (this.bytes > this.budget.fileCap)
      return done(new SpoolLimitError(`a file passes ${this.budget.fileCap} bytes`));
    if (this.budget.used > this.budget.cap)
      return done(new SpoolLimitError(`its files together pass ${this.budget.cap} bytes`));
    this.push(chunk);
    done();
  }
}

/** Writes a stream to `file`, cut the moment the file or the report's total passes its cap. */
export async function spoolStream(
  source: Readable | AsyncIterable<Uint8Array>,
  file: string,
  budget: SpoolBudget
) {
  await pipeline(source, new Counted(budget), fs.createWriteStream(file));
}

/** A spooled file as the File an upload takes, backed by the file on disk. */
export async function spooledFile({ path: file, filename, type }: SpooledFile) {
  return new File([await fs.openAsBlob(file, { type })], filename, { type });
}

/**
 * A URL's body written to `file`, or null for an error response. A URL ending in .mp4, .jpg or .jpeg
 * is typed by that extension, any other as the response says. A request that fails, or a body cut
 * short, throws.
 */
export async function spoolUrl(url: string, file: string, budget: SpoolBudget) {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(120_000),
    credentials: 'omit',
  });
  if (!response.ok || !response.body) return null;
  await spoolStream(Readable.fromWeb(response.body as NodeReadableStream), file, budget);
  // The orchestrator can serve these as application/octet-stream.
  if (url.endsWith('.mp4')) return { type: 'video/mp4' };
  if (url.endsWith('.jpg') || url.endsWith('.jpeg')) return { type: 'image/jpeg' };
  return { type: response.headers.get('content-type')?.split(';')[0].trim().toLowerCase() ?? '' };
}

/**
 * Each media entry of the zip at `zipFile`, inflated into `dir` one at a time and named there by its
 * position, so no name from the archive reaches the file system. An entry that is empty or cannot be
 * inflated is skipped and recorded on the budget; only the budget's caps fail the archive. Untyped,
 * as an entry read whole is.
 */
export async function spoolZip(zipFile: string, dir: string, budget: SpoolBudget) {
  const zip = await new Promise<yauzl.ZipFile>((resolve, reject) =>
    yauzl.open(
      zipFile,
      // Undecoded, so yauzl refuses no name ("..", "/x", "C:x"): one entry named so would otherwise
      // fail the whole archive. Declared sizes bound nothing either: the budget counts what inflates.
      { lazyEntries: true, autoClose: false, validateEntrySizes: false, decodeStrings: false },
      (error, opened) => (error || !opened ? reject(error) : resolve(opened))
    )
  );
  const files: SpooledFile[] = [];
  const skip = (name: string, reason: SkippedEntry['reason'], error?: string) =>
    budget.skipped.push({ name: name.slice(0, 256), reason, ...(error && { error }) });
  try {
    for (;;) {
      const entry = await new Promise<yauzl.Entry | null>((resolve, reject) => {
        const onEntry = (next: yauzl.Entry) => settle(() => resolve(next));
        const onEnd = () => settle(() => resolve(null));
        const onError = (error: Error) => settle(() => reject(error));
        function settle(then: () => void) {
          zip.off('entry', onEntry).off('end', onEnd).off('error', onError);
          then();
        }
        zip.on('entry', onEntry).on('end', onEnd).on('error', onError);
        zip.readEntry();
      });
      if (!entry) break;
      const filename = yauzl.getFileNameLowLevel(
        entry.generalPurposeBitFlag,
        entry.fileNameRaw,
        entry.extraFields,
        false
      );
      if (!isTrainingMediaEntry(filename)) continue;
      if (++budget.entries > MAX_SPOOL_ENTRIES_PER_REPORT)
        throw new SpoolLimitError(
          `its archives hold more than ${MAX_SPOOL_ENTRIES_PER_REPORT} files`
        );
      // A skipped entry's file is removed, so the next one may take its name.
      const file = path.join(dir, `entry-${files.length}`);
      try {
        const stream = await new Promise<Readable>((resolve, reject) =>
          zip.openReadStream(entry, (error, readable) =>
            error || !readable ? reject(error) : resolve(readable)
          )
        );
        await spoolStream(stream, file, budget);
      } catch (e) {
        if (e instanceof SpoolLimitError) throw e;
        await fs.promises.rm(file, { force: true });
        skip(filename, 'unreadable', (e as Error).message);
        continue;
      }
      if ((await fs.promises.stat(file)).size === 0) {
        await fs.promises.rm(file);
        skip(filename, 'empty');
        continue;
      }
      files.push({ path: file, filename, type: '' });
    }
  } finally {
    zip.close();
  }
  return files;
}
