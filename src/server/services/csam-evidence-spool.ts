import fs from 'fs';
import path from 'path';
import { Readable, Transform } from 'stream';
import { pipeline } from 'stream/promises';
import type { ReadableStream as NodeReadableStream } from 'stream/web';
import * as yauzl from 'yauzl';
import { isTrainingMediaEntry } from '~/utils/training';

/**
 * A send whose files come from a URL or a zip writes each one to disk as it streams in, so a file is
 * held in memory only while it is uploaded (the CyberTip client's upload reads its File whole), one at
 * a time. Every byte is counted as it actually arrives or inflates, not as a header declares: one file
 * may not pass MAX_SPOOL_FILE_BYTES, nor one report's files together MAX_SPOOL_BYTES_PER_REPORT.
 */
export const MAX_SPOOL_BYTES_PER_REPORT = 1024 ** 3;
/** As a preserved evidence file may be (MAX_EVIDENCE_BYTES). */
export const MAX_SPOOL_FILE_BYTES = 256 * 1024 * 1024;

export class SpoolLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SpoolLimitError';
  }
}

export type SpoolBudget = { used: number; readonly cap: number; readonly fileCap: number };
export const spoolBudget = (
  cap = MAX_SPOOL_BYTES_PER_REPORT,
  fileCap = Math.min(cap, MAX_SPOOL_FILE_BYTES)
): SpoolBudget => ({ used: 0, cap, fileCap });

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
 * A URL's body written to `file`, typed as the response says, or null for an error response. A
 * request that fails, or a body cut short, throws.
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
 * Each media entry of the zip at `zipFile`, inflated into `dir` one at a time, named there by its
 * position so no name from the archive reaches the file system. Untyped, as an entry read whole is.
 */
export async function spoolZip(zipFile: string, dir: string, budget: SpoolBudget) {
  const zip = await new Promise<yauzl.ZipFile>((resolve, reject) =>
    yauzl.open(
      zipFile,
      // The declared sizes are not trusted to bound what inflates: the budget counts what comes out.
      { lazyEntries: true, autoClose: false, validateEntrySizes: false },
      (error, opened) => (error || !opened ? reject(error) : resolve(opened))
    )
  );
  const files: SpooledFile[] = [];
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
      if (!isTrainingMediaEntry(entry.fileName)) continue;
      const stream = await new Promise<Readable>((resolve, reject) =>
        zip.openReadStream(entry, (error, readable) =>
          error || !readable ? reject(error) : resolve(readable)
        )
      );
      const file = path.join(dir, `entry-${files.length}`);
      await spoolStream(stream, file, budget);
      files.push({ path: file, filename: entry.fileName, type: '' });
    }
  } finally {
    zip.close();
  }
  return files;
}
