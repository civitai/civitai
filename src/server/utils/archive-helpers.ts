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

/** S3 hard limit: a multipart upload may have at most this many parts. */
export const S3_MAX_UPLOAD_PARTS = 10_000;

/** S3 hard limit: every part except the final one must be at least this large. */
export const S3_MIN_PART_SIZE_BYTES = 5 * 1024 * 1024; // 5 MiB

/**
 * Our ceiling on a single part, far below S3's own 5 GiB maximum.
 *
 * The ceiling is what bounds the largest object this can produce:
 * `S3_MAX_UPLOAD_PARTS * MAX_PART_SIZE_BYTES` = 10,000 x 256 MiB = 2.44 TiB. That is orders of
 * magnitude above any archive this code is asked to build, so the ceiling never binds in
 * practice — it exists so a wildly wrong size estimate cannot ask for a 5 GiB part.
 */
export const MAX_PART_SIZE_BYTES = 256 * 1024 * 1024; // 256 MiB

/**
 * 🔴 Hard cap on `queueSize * partSize`, which is what `@aws-sdk/lib-storage` holds RESIDENT.
 *
 * `Upload` buffers up to `queueSize` parts of `partSize` bytes each while they are in flight.
 * That memory is in ADDITION to everything `createBoundedArchive` bounds, so it has to be
 * budgeted, not left to whatever `partSize` the size estimate happens to produce. Naively
 * keeping `queueSize: 4` next to a 100 MiB part is ~400 MiB resident — for a process whose
 * whole memory story is the reason this module exists.
 *
 * `deriveUploadPartGeometry` derives `queueSize` FROM this budget, so worst-case resident bytes
 * are this constant by construction, whatever the estimate says. 256 MiB sits comfortably inside
 * the container's memory allowance alongside the archiver's own bounded working set.
 */
export const UPLOAD_BUFFER_BUDGET_BYTES = 256 * 1024 * 1024; // 256 MiB

/** Upper bound on upload parallelism. Matches the value this code used before part sizing existed. */
export const MAX_UPLOAD_QUEUE_SIZE = 4;

/**
 * Multiplier applied to the caller's size estimate before dividing it into parts.
 *
 * The estimate is `entryCount * bytes-per-entry` off an observed average, so it is wrong in both
 * directions on any individual archive. Wrong-LOW is the direction that fails hard: exceeding
 * `S3_MAX_UPLOAD_PARTS` aborts the upload outright. Wrong-HIGH costs nothing at all — a larger
 * `partSize` is compensated by a smaller `queueSize`, and the resident total is pinned by
 * `UPLOAD_BUFFER_BUDGET_BYTES` either way. Asymmetric consequences, so bias generously.
 */
export const PART_SIZE_ESTIMATE_HEADROOM = 4;

export type UploadPartGeometry = {
  /** Bytes per multipart part. */
  partSize: number;
  /** Parts buffered in flight. */
  queueSize: number;
  /** Largest object this geometry can upload before hitting the S3 part limit. */
  maxObjectBytes: number;
  /** `queueSize * partSize` — what the upload holds resident at peak. */
  worstCaseResidentBytes: number;
};

/**
 * Chooses `partSize`/`queueSize` for a multipart upload from an estimate of the object's size.
 *
 * WHY THIS EXISTS: a fixed 5 MiB part size caps any object at `10,000 * 5 MiB` = 48.8 GiB,
 * because S3 refuses an upload with more than 10,000 parts. An archive larger than that fails
 * with a part-limit error rather than a disk or memory error, which is a different failure with
 * the same outcome — the bundle cannot be produced.
 *
 * The two knobs are NOT independent. `partSize` is set by the part-count limit (how large the
 * object may be); `queueSize` is then whatever fits the memory budget alongside it. Raising one
 * lowers the other, which is the property that makes worst-case resident bytes a constant.
 *
 * `expectedBytes` omitted (or non-finite/non-positive) yields the S3 minimum part size and full
 * parallelism — byte-for-byte the geometry this code used before, so the small uploads that pass
 * no estimate are unaffected.
 */
export function deriveUploadPartGeometry({
  expectedBytes,
}: {
  expectedBytes?: number;
}): UploadPartGeometry {
  const usableEstimate =
    typeof expectedBytes === 'number' && Number.isFinite(expectedBytes) && expectedBytes > 0
      ? expectedBytes
      : 0;

  const requiredPartSize = Math.ceil(
    (usableEstimate * PART_SIZE_ESTIMATE_HEADROOM) / S3_MAX_UPLOAD_PARTS
  );

  const partSize = Math.min(
    MAX_PART_SIZE_BYTES,
    Math.max(S3_MIN_PART_SIZE_BYTES, requiredPartSize)
  );

  // At least 1: a budget smaller than one part still has to upload, serially.
  const queueSize = Math.max(
    1,
    Math.min(MAX_UPLOAD_QUEUE_SIZE, Math.floor(UPLOAD_BUFFER_BUDGET_BYTES / partSize))
  );

  return {
    partSize,
    queueSize,
    maxObjectBytes: partSize * S3_MAX_UPLOAD_PARTS,
    worstCaseResidentBytes: partSize * queueSize,
  };
}

/**
 * Bytes to budget per archived image when estimating an archive's size.
 *
 * The media is already entropy-coded and `MEDIA_ARCHIVE_COMPRESSION_LEVEL` is 1, so the zip is
 * very close to the sum of its inputs and `entryCount * this` is a serviceable estimate. It only
 * feeds `deriveUploadPartGeometry`, whose headroom and clamps absorb the error — see
 * `PART_SIZE_ESTIMATE_HEADROOM` for why erring high is free.
 */
export const ESTIMATED_BYTES_PER_ARCHIVED_IMAGE = Math.round(1.4 * 1024 * 1024);

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
 * one such URL now fails the whole report rather than being silently dropped. Failing loudly is
 * the right default here — a dropped entry means a piece of evidence is missing from an archive
 * nobody will re-derive — but an unnameable URL is not a reason to make a report permanently
 * unarchivable, and it is a shape the orchestrator can legitimately produce:
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
  /**
   * The sink `archive` is piped to, awaited to `'close'` on `finalize` so the bytes are really on
   * disk — archiver's own `finalize()` resolves when the zip module ends, measurably before the
   * sink has flushed. Unlike `writeJsonObject`, nothing else here waits on the sink, so this wait
   * is load-bearing rather than redundant. It does require a sink that emits `'close'`: both call
   * sites pass `fs.createWriteStream`, which does; a Writable built with `autoDestroy: false`
   * never emits it and would hang here.
   */
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

  // 🔴 The `while` is what makes the FAILURE path settle, and must not be narrowed to an `if`.
  // An earlier revision of this comment said the opposite — "that re-check is the actual guard",
  // meaning the one in `append()` — and invited exactly that edit.
  //
  // `releaseWaiters` is called from exactly two places: `entry` and `error`. Once `failure` is
  // latched no new entries are produced, because `append()` rejects immediately — so if the
  // error is the last event the archive emits, it is also the last wake-up any parked waiter
  // gets. Releasing one waiter per event strands the rest forever. Measured against this module
  // with an archive stub emitting a single `error` and no `entry`: 2 of 5 appends never settle
  // (`raced: 'HUNG', settled: 3`). Pinned by "settles EVERY parked append when the archiver
  // errors" in `archive-helpers.test.ts`.
  //
  // ⚠️ SCOPE OF THAT CLAIM, because it is easy to overstate and was overstated once already:
  // it is about THIS module's contract, not a reproduced production wedge. `archiver@6` has 23
  // separate `emit('error')` sites and no "at most one error" guarantee either way; three of its
  // real failure paths were probed and NONE reaches the stranding shape. An empty entry name
  // emits `error` and then goes on emitting `entry` (8 more), so an `if` would drain there. A
  // directory entry emits no `error` at all. A source stream that errors makes the archiver
  // stall silently with no `error` event, which no variant of this loop can rescue. So the
  // `while` is the cheap way to keep the contract true whichever site fires — not a fix for a
  // hang anyone has observed in production.
  //
  // On the SUCCESS path the loop over-releases rather than handing out one wake-up per free
  // slot: `pending` is only incremented once a woken waiter actually resumes, on a later
  // microtask, so `pending < maxPendingEntries` is still true on the second and subsequent
  // iterations. That is harmless because `append()` re-checks the bound in its own `while` and a
  // waiter that finds no free slot simply parks again — that re-check is what upholds the bound.
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
