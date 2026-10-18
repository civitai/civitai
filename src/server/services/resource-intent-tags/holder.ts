import { dbRead } from '~/server/db/client';
import { FLIPT_FEATURE_FLAGS, isFlipt } from '~/server/flipt/client';
import { logToAxiom } from '~/server/logging/client';
import {
  recordTagIndexLoad,
  setHeldTagIndex,
  type HeldTagIndex,
  type TagIndexLoadOutcome,
} from '~/server/prom/resource-intent-tags.metrics';
import { coocSqlOf, type CoocSql } from '~/server/services/resource-intent-cooc/store';
import { withTimeoutFallback } from '~/server/utils/timeout-helpers';
import { s3TagIndexObjects } from './objects';
import type { DecodedTagIndex } from './payload';
import type { TagIndex } from './score';
import {
  latestReadyManifest,
  loadManifestSnapshot,
  readyIds,
  TagIndexSnapshotUnservableError,
  untilAborted,
  type TagIndexObjectStore,
} from './store';

/**
 * In-process holder of the v1 tag index the request path serves and shadows (`resource-intent.service.ts`,
 * the v1_tags arm, reached only behind its own flags).
 *
 * 🔴 Behind the default-off Flipt flag `resource-intent-tag-index-holder`. While it is off (or
 * unknown, or Flipt is unreachable), `resolve()` answers `disabled` and touches nothing: no
 * database read, no download, no worker, and a snapshot already held is dropped. So a pod that
 * never has the flag on holds nothing of the index.
 *
 * On: the newest ready snapshot built under this code's `RESOURCE_INTENT_TAGS_SPEC_HASH`
 * (`latestReadyManifest`), re-checked at most every `TAG_INDEX_POLL_MS` (plus jitter) when asked for,
 * loaded once per change, and shared by every caller; concurrent callers share one in-flight check.
 * A load streams the object (verifying its size and sha256 against the manifest), then decodes and
 * validates it on a worker thread (`decodeTagIndexInWorker`), so the event loop is not held for the
 * decode. The held index is replaced only once the new one has fully loaded and validated; a failed
 * load keeps it. A snapshot refused as unservable is not downloaded again while its row is ready;
 * the newest ready row no refusal names is served instead. Retiring the served row makes the
 * next check serve the previous ready row, and retiring every row makes it hold nothing
 * (`no_snapshot`). A check still running at `TAG_INDEX_LOAD_TIMEOUT_MS` is aborted (its download and
 * decode worker stop, and it stops waiting on a database read), and no new check starts until it
 * has settled, so loads do not overlap. Lazy, like the co-occurrence
 * holder (serving design D10): a pod loads on its first request, not at start.
 *
 * Only pods whose code has this spec hash can serve a snapshot built under it, and the query asks
 * for no other: after a release that moves `RESOURCE_INTENT_TAGS_SPEC_HASH`, pods answer
 * `no_snapshot` until a build under the new hash lands (run one by hand rather than wait a week).
 */

export const TAG_INDEX_POLL_MS = 5 * 60_000;
/** Spreads pods' checks so a new build is not downloaded by every pod in the same instant. */
export const TAG_INDEX_POLL_JITTER_MS = 60_000;
/** A failed check is retried this long after it failed, sooner than the poll. */
export const TAG_INDEX_RETRY_MS = 60_000;
/** A check still running after this is aborted as failed; a late result is discarded. */
export const TAG_INDEX_LOAD_TIMEOUT_MS = 120_000;
/**
 * With nothing held, requests arriving in a load's first 10 s wait for it (up to 10 s); once that
 * window has passed without a result, later requests get the fallback at once.
 */
export const TAG_INDEX_FIRST_LOAD_WAIT_MS = 10_000;

export type TagIndexFallbackReason =
  | 'disabled'
  | 'no_snapshot'
  | 'load_failed'
  | 'snapshot_unservable'
  | 'loading';

export type ServedTagIndex = HeldTagIndex & { index: TagIndex };

export type TagIndexServing =
  | { snapshot: ServedTagIndex; fallbackReason: null }
  | { snapshot: null; fallbackReason: TagIndexFallbackReason };

export type TagIndexHolderDeps = {
  /** Whether the holder flag is on; read on every `resolve()`. */
  enabled: () => Promise<boolean>;
  sql: () => CoocSql;
  objects: () => TagIndexObjectStore;
  decode: (payload: Uint8Array, signal?: AbortSignal) => Promise<DecodedTagIndex>;
  /** The spec hash this code builds and serves under (`RESOURCE_INTENT_TAGS_SPEC_HASH`). */
  specHash: () => Promise<string>;
  now?: () => number;
  /** In [0, 1); scales the poll jitter. */
  random?: () => number;
  /**
   * A check's outcome. `seconds`: wall time since the load began (null when the check loaded
   * nothing); for a check abandoned at the timeout, since the check began.
   */
  onLoad?: (
    outcome: TagIndexLoadOutcome,
    seconds: number | null,
    snapshotId: string | null
  ) => void;
  onHeld?: (held: HeldTagIndex | null) => void;
  onLoadFailure?: (reason: TagIndexFallbackReason, error: unknown, seconds: number | null) => void;
};

const TIMED_OUT = Symbol('timed-out');

function delay(ms: number): { done: Promise<typeof TIMED_OUT>; cancel: () => void } {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const done = new Promise<typeof TIMED_OUT>((res) => {
    timer = setTimeout(() => res(TIMED_OUT), ms);
  });
  return { done, cancel: () => clearTimeout(timer) };
}

type Flight = { done: Promise<void>; waitSpent: boolean };

const identity = (s: ServedTagIndex): HeldTagIndex => ({
  id: s.id,
  payloadSha256: s.payloadSha256,
  specHash: s.specHash,
  vocabVersion: s.vocabVersion,
  createdAt: s.createdAt,
});

export class TagIndexSnapshotHolder {
  private served: ServedTagIndex | null = null;
  private reason: TagIndexFallbackReason = 'loading';
  /**
   * Ids refused as unservable, each kept while its row is still ready: none is downloaded again,
   * and the newest ready row outside the set is served instead.
   */
  private readonly rejected = new Set<string>();
  private nextCheckAt = -Infinity;
  private flight: Flight | null = null;
  /**
   * The last check's work, until it settles. A check abandoned at the timeout is aborted (its
   * download and decode worker stop; it stops waiting on a database read), and no new check starts
   * until its work has settled, so two loads never overlap.
   */
  private running: Promise<void> | null = null;
  private generation = 0;

  constructor(private readonly deps: TagIndexHolderDeps) {}

  private now() {
    return (this.deps.now ?? Date.now)();
  }

  /**
   * What to serve now. With the flag off: `disabled`, and nothing is read or kept. With it on and
   * nothing held: waits for a load started in the last `TAG_INDEX_FIRST_LOAD_WAIT_MS`, else answers
   * with the reason nothing is held. Once something is held, it never waits.
   */
  async resolve(): Promise<TagIndexServing> {
    if (!(await this.deps.enabled())) {
      this.disable();
      return { snapshot: null, fallbackReason: 'disabled' };
    }
    // `running` outlives `flight` (a timed-out check's work is still stopping), so it alone keeps
    // checks single-flight and non-overlapping.
    if (!this.running && this.now() >= this.nextCheckAt) this.flight = this.startCheck();
    const flight = this.flight;
    if (!this.served && flight) {
      if (!flight.waitSpent) {
        const wait = delay(TAG_INDEX_FIRST_LOAD_WAIT_MS);
        if ((await Promise.race([flight.done, wait.done])) === TIMED_OUT) flight.waitSpent = true;
        wait.cancel();
      }
      if (!this.served && this.flight === flight)
        return { snapshot: null, fallbackReason: 'loading' };
    }
    return this.served
      ? { snapshot: this.served, fallbackReason: null }
      : { snapshot: null, fallbackReason: this.reason };
  }

  /** Forget everything; a check in flight is aborted, and any result it reaches is discarded. */
  private disable() {
    if (this.served) this.deps.onHeld?.(null);
    this.served = null;
    this.reason = 'loading';
    this.rejected.clear();
    this.nextCheckAt = -Infinity;
    this.generation++;
    this.abort?.abort();
  }

  private abort: AbortController | null = null;

  private startCheck(): Flight {
    const gen = ++this.generation;
    const startedAt = this.now();
    const abort = new AbortController();
    this.abort = abort;
    const work = this.refresh(gen, startedAt, abort.signal);
    const running = work.finally(() => {
      if (this.running === running) this.running = null;
    });
    this.running = running;
    const done = withTimeoutFallback<void | typeof TIMED_OUT>(
      work,
      TAG_INDEX_LOAD_TIMEOUT_MS,
      TIMED_OUT
    )
      .then((result) => {
        if (result !== TIMED_OUT || gen !== this.generation) return;
        this.generation++;
        abort.abort();
        this.fail(
          new Error('tag index snapshot check timed out'),
          this.now(),
          null,
          (this.now() - startedAt) / 1000
        );
      })
      .finally(() => {
        if (this.flight?.done === done) this.flight = null;
      });
    return { done, waitSpent: false };
  }

  /**
   * `snapshot`: the id being loaded when it failed, if a load had started. A snapshot whose stored
   * bytes, header or vocabulary are refused fails the same way on every re-read: it is remembered and
   * the poll kept. Anything else (database, network, a decode worker that did not answer, running out
   * of memory, a timeout) is retried `TAG_INDEX_RETRY_MS` later.
   */
  private fail(error: unknown, at: number, snapshot: string | null, loadSeconds: number | null) {
    const unservable = snapshot !== null && error instanceof TagIndexSnapshotUnservableError;
    const reason: 'snapshot_unservable' | 'load_failed' = unservable
      ? 'snapshot_unservable'
      : 'load_failed';
    if (unservable) this.rejected.add(snapshot);
    this.nextCheckAt = unservable ? this.pollAfter(at) : at + TAG_INDEX_RETRY_MS;
    if (!this.served) this.reason = reason;
    this.deps.onLoad?.(reason, loadSeconds, snapshot);
    this.deps.onLoadFailure?.(reason, error, loadSeconds);
  }

  private pollAfter(startedAt: number) {
    return (
      startedAt + TAG_INDEX_POLL_MS + (this.deps.random ?? Math.random)() * TAG_INDEX_POLL_JITTER_MS
    );
  }

  /**
   * The newest ready row no refusal names. A refusal is forgotten only once its row is no longer
   * ready (retired), so retiring the served row still rolls back past refused rows, and a refused
   * row is never downloaded again while it stays ready, newest or not.
   */
  private async servable(sql: CoocSql, specHash: string, signal: AbortSignal) {
    if (this.rejected.size) {
      const ready = await untilAborted(readyIds(sql, [...this.rejected]), signal);
      for (const id of [...this.rejected]) if (!ready.has(id)) this.rejected.delete(id);
    }
    return untilAborted(latestReadyManifest(sql, specHash, [...this.rejected]), signal);
  }

  private async refresh(gen: number, startedAt: number, signal: AbortSignal): Promise<void> {
    let loading: string | null = null;
    let loadStart = 0;
    try {
      const sql = this.deps.sql();
      const latest = await this.servable(sql, await this.deps.specHash(), signal);
      if (gen !== this.generation) return;
      if (!latest) {
        if (this.served) this.deps.onHeld?.(null);
        this.served = null;
        this.reason = this.rejected.size ? 'snapshot_unservable' : 'no_snapshot';
      } else if (latest.id !== this.served?.id) {
        if (this.served && latest.payloadSha256 === this.served.payloadSha256) {
          // Another row naming the same bytes (a re-put after a retire): nothing to download.
          this.served = { ...this.served, id: latest.id, createdAt: latest.createdAt };
          this.deps.onHeld?.(identity(this.served));
        } else {
          loading = latest.id;
          loadStart = this.now();
          // Not raced against the signal: `running` must track the load itself, which stops on the
          // abort (its reads, download, decode worker and assembly all take the signal).
          const { index } = await loadManifestSnapshot(
            { sql, objects: this.deps.objects(), decode: this.deps.decode },
            latest,
            signal
          );
          if (gen !== this.generation) return;
          this.served = {
            id: latest.id,
            payloadSha256: latest.payloadSha256,
            specHash: latest.specHash,
            vocabVersion: latest.vocabVersion,
            createdAt: latest.createdAt,
            index,
          };
          this.deps.onLoad?.('success', (this.now() - loadStart) / 1000, latest.id);
          this.deps.onHeld?.(identity(this.served));
        }
      }
      this.nextCheckAt = this.pollAfter(startedAt);
    } catch (error) {
      if (gen === this.generation)
        this.fail(
          error,
          this.now(),
          loading,
          loading === null ? null : (this.now() - loadStart) / 1000
        );
    }
  }
}

let holder: TagIndexSnapshotHolder | undefined;

/**
 * The process's holder: the accessor the request path calls
 * (`await tagIndexSnapshotHolder().resolve()`). Constructing it allocates nothing of the index, and
 * the spec hash (computed over fixtures when `./spec` loads) and the decode worker's source are
 * imported only by a check, which runs only with the flag on.
 */
export function tagIndexSnapshotHolder(): TagIndexSnapshotHolder {
  return (holder ??= new TagIndexSnapshotHolder({
    enabled: () => isFlipt(FLIPT_FEATURE_FLAGS.RESOURCE_INTENT_TAG_INDEX_HOLDER),
    sql: () => coocSqlOf(dbRead),
    objects: () => s3TagIndexObjects(),
    decode: async (payload, signal) =>
      (await import('./decode-worker')).decodeTagIndexInWorker(payload, { signal }),
    specHash: async () => (await import('./spec')).RESOURCE_INTENT_TAGS_SPEC_HASH,
    onLoad: (outcome, seconds, snapshotId) => {
      recordTagIndexLoad(outcome, seconds);
      // Per-load time on a log line too; the histogram only aggregates.
      if (outcome === 'success')
        logToAxiom(
          { type: 'resource-intent-tag-index-loaded', snapshotId, seconds },
          'temp-search'
        ).catch(() => undefined);
    },
    onHeld: setHeldTagIndex,
    onLoadFailure: (reason, error, seconds) => {
      logToAxiom(
        {
          type: 'resource-intent-tag-index-load-failed',
          reason,
          seconds,
          error: error instanceof Error ? error.message : String(error),
        },
        'temp-search'
      ).catch(() => undefined);
    },
  }));
}
