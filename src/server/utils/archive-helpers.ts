import type { Archiver, EntryData } from 'archiver';
import type { Readable, Writable } from 'stream';

/**
 * Compression level for archives whose entries are already-compressed media (JPEG/WebP/PNG).
 *
 * Deflate cannot meaningfully shrink bytes that are already entropy-coded, so level 9 spends a
 * large amount of CPU for close to nothing. That matters beyond wasted cycles: deflate is the
 * *consumer* in these archives, and a slow consumer behind a fast network producer is what lets
 * the pending-entry queue grow (see `createBoundedArchive`). Dropping the level moves the
 * bottleneck back to the network, where it belongs.
 *
 * The resulting archives are evidence bundles that are uploaded as-is; nothing reads them back
 * or depends on their size, so a slightly larger zip is free.
 */
export const MEDIA_ARCHIVE_COMPRESSION_LEVEL = 1;

/**
 * Default ceiling on entries that have been handed to the archiver but not yet compressed and
 * written out. Each pending entry pins its whole source buffer in memory, so this is the knob
 * that converts "memory grows with the number of files" into "memory is constant".
 *
 * ⚠️ It is NOT the whole peak, and reading it as "8 image-sizes" understates the constant by
 * roughly 5×. At the CSAM call sites the appender runs behind a `p-limit(10)`, and each of
 * those 10 slots holds its own `blob`, `arrayBuffer` and `buffer` for the whole time it is
 * parked inside `append()` waiting for a slot here. So the realistic peak is about
 * `8 + 3 × 10 = 38` image-sizes, not 8.
 *
 * That is the point regardless: 38 is a CONSTANT, set by the two concurrency caps. The defect
 * being fixed is that the peak previously scaled with how many images the account had.
 */
export const MAX_PENDING_ARCHIVE_ENTRIES = 8;

/**
 * Zip entry name for a media URL, guaranteed non-empty.
 *
 * `archiver` rejects an entry with an empty name (`ENTRYNAMEREQUIRED`), and since the error
 * handling in `createBoundedArchive` latches archive errors and rethrows them from `finalize()`,
 * one such URL now fails the whole report rather than being silently dropped. That is the right
 * default for evidence — see the file header — but an unnameable URL is not a reason to make a
 * report permanently unarchivable, and it is a shape the orchestrator can legitimately produce:
 * `https://host/blob/` and `https://host/?x` both reduce to `''` under the basename expression.
 *
 * The basename expression is evaluated FIRST and returned verbatim whenever it is non-empty, so
 * every URL that already produced a usable name keeps byte-identical naming. The fallback only
 * runs where the old code would have produced `''`.
 */
export function zipEntryNameForUrl(url: string, index: number): string {
  const basename = url.split('/').reverse()[0].split('?')[0];
  if (basename.length) return basename;

  // Nothing usable at the end of the path — keep whatever provenance the path still carries so
  // the entry is traceable back to its source, and fall back to the position in the batch when
  // even that is empty. `index` makes the name unique within one archive.
  const path = url
    .split('?')[0]
    .split('#')[0]
    .replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]*/i, '');
  const slug = path.replace(/[^a-zA-Z0-9._-]+/g, '_').replace(/^_+|_+$/g, '');
  return slug.length ? `unnamed-${index}-${slug}` : `unnamed-${index}`;
}

export type BoundedArchive = {
  /**
   * Appends an entry, first waiting until the archiver has drained below the pending-entry
   * ceiling. Resolves once the entry has been accepted (not once it has been written).
   */
  append: (source: Buffer | Readable, data: EntryData) => Promise<void>;
  /** Finalizes the archive and waits for the output sink to flush and close. */
  finalize: () => Promise<void>;
  /** Entries appended but not yet processed. Exposed for tests and diagnostics. */
  readonly pendingEntries: number;
  /** High-water mark of `pendingEntries`. Exposed for tests and diagnostics. */
  readonly peakPendingEntries: number;
};

/**
 * Wraps an `archiver` instance with backpressure.
 *
 * `archive.append()` is fire-and-forget: it pushes the source onto an unbounded internal queue
 * that is drained by a single worker. When the producer is a fast network fetch and the consumer
 * is deflate, the queue — and therefore the retained source buffers — grows without limit. For a
 * user with a large media library that is enough to exhaust the container's memory. The buffers
 * are external/off-heap, so a `--max-old-space-size` cap never engages first; the container limit
 * is what is hit.
 *
 * `archiver` emits `entry` once per processed entry, which is the signal used here to release
 * append slots.
 *
 * This also takes over the `error` event. Throwing from an `error` listener (the previous
 * shape) surfaces as an uncaught exception from inside archiver's async internals rather than as
 * a rejection the caller can handle; capturing it instead lets `append`/`finalize` reject so the
 * caller's own try/catch decides what happens.
 */
export function createBoundedArchive({
  archive,
  output,
  maxPendingEntries = MAX_PENDING_ARCHIVE_ENTRIES,
}: {
  archive: Archiver;
  /** The sink `archive` is piped to. Awaited on `finalize` so the bytes are actually on disk. */
  output?: Writable;
  maxPendingEntries?: number;
}): BoundedArchive {
  if (!Number.isInteger(maxPendingEntries) || maxPendingEntries < 1) {
    throw new Error(
      `maxPendingEntries must be a positive integer, received ${String(maxPendingEntries)}`
    );
  }

  let pending = 0;
  let peak = 0;
  let failure: Error | undefined;
  const waiters: Array<() => void> = [];

  // Releases EVERY waiter whenever at least one slot is free — it does not hand out one wake-up
  // per free slot. `pending` is only incremented once a woken waiter actually resumes, which
  // happens on a later microtask, so the `pending < maxPendingEntries` test below is still true
  // for the second and subsequent iterations of this loop and the whole queue drains.
  //
  // The bound is upheld anyway, by the `while` re-check in `append()`: a woken waiter that finds
  // no free slot simply parks again. That re-check is the actual guard — a maintainer who
  // "optimises" it into an `if` on the strength of this loop's name would break the bound.
  const releaseWaiters = () => {
    while (waiters.length > 0 && (failure !== undefined || pending < maxPendingEntries)) {
      waiters.shift()?.();
    }
  };

  archive.on('entry', () => {
    if (pending > 0) pending--;
    releaseWaiters();
  });

  archive.on('error', (err: unknown) => {
    failure ??= err instanceof Error ? err : new Error(String(err));
    releaseWaiters();
  });

  return {
    get pendingEntries() {
      return pending;
    },
    get peakPendingEntries() {
      return peak;
    },
    async append(source, data) {
      if (failure) throw failure;
      while (pending >= maxPendingEntries) {
        await new Promise<void>((resolve) => waiters.push(resolve));
        if (failure) throw failure;
      }
      pending++;
      if (pending > peak) peak = pending;
      archive.append(source, data);
    },
    async finalize() {
      if (failure) throw failure;
      // Registered before `finalize()` so the event cannot be missed.
      const closed = output
        ? new Promise<void>((resolve, reject) => {
            output.once('close', () => resolve());
            output.once('error', reject);
          })
        : undefined;

      // `finalize()` resolves when the zip module ends, which is NOT when the sink has flushed:
      // measured against archiver 6.0.2, a file was 24254 bytes at that point and 25342 bytes once
      // the write stream closed. Reading the file in between yields a truncated archive.
      await archive.finalize();
      if (closed) await closed;
      if (failure) throw failure;
    },
  };
}
