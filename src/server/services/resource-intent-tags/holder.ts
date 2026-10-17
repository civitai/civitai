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
  TagIndexSnapshotUnservableError,
  type TagIndexObjectStore,
} from './store';

/**
 * In-process holder of the v1 tag index the request path will serve (design phase P9 wires it in;
 * nothing calls it yet).
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
 * load keeps it. Retiring the served row makes the next check serve the previous ready row, and
 * retiring every row makes it hold nothing (`no_snapshot`). Lazy, like the co-occurrence holder
 * (serving design D10): a pod loads on its first request, not at start.
 */

export const TAG_INDEX_POLL_MS = 5 * 60_000;
/** Spreads pods' checks so a new build is not downloaded by every pod in the same instant. */
export const TAG_INDEX_POLL_JITTER_MS = 60_000;
/** A failed check is retried this long after it failed, sooner than the poll. */
export const TAG_INDEX_RETRY_MS = 60_000;
/** A check still running after this is abandoned as failed; a late result is discarded. */
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
  decode: (payload: Uint8Array) => Promise<DecodedTagIndex>;
  /** The spec hash this code builds and serves under (`RESOURCE_INTENT_TAGS_SPEC_HASH`). */
  specHash: () => Promise<string>;
  now?: () => number;
  /** In [0, 1); scales the poll jitter. */
  random?: () => number;
  onLoad?: (outcome: TagIndexLoadOutcome, seconds: number | null) => void;
  onHeld?: (held: HeldTagIndex | null) => void;
  onLoadFailure?: (reason: TagIndexFallbackReason, error: unknown) => void;
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
  /** A snapshot id refused as unservable; not downloaded again until another one is newest. */
  private rejected: string | null = null;
  private nextCheckAt = -Infinity;
  private flight: Flight | null = null;
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
    if (!this.flight && this.now() >= this.nextCheckAt) this.flight = this.startCheck();
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

  /** Forget everything; a check in flight finishes, and its result is discarded. */
  private disable() {
    if (this.served) this.deps.onHeld?.(null);
    this.served = null;
    this.reason = 'loading';
    this.rejected = null;
    this.nextCheckAt = -Infinity;
    this.generation++;
  }

  private startCheck(): Flight {
    const gen = ++this.generation;
    const startedAt = this.now();
    const done = withTimeoutFallback<void | typeof TIMED_OUT>(
      this.refresh(gen, startedAt),
      TAG_INDEX_LOAD_TIMEOUT_MS,
      TIMED_OUT
    )
      .then((result) => {
        if (result !== TIMED_OUT || gen !== this.generation) return;
        this.generation++;
        this.fail(new Error('tag index snapshot check timed out'), this.now(), null);
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
  private fail(error: unknown, at: number, snapshot: string | null, loadSeconds?: number) {
    const unservable = snapshot !== null && error instanceof TagIndexSnapshotUnservableError;
    const reason: 'snapshot_unservable' | 'load_failed' = unservable
      ? 'snapshot_unservable'
      : 'load_failed';
    if (unservable) this.rejected = snapshot;
    this.nextCheckAt = unservable ? this.pollAfter(at) : at + TAG_INDEX_RETRY_MS;
    if (!this.served) this.reason = reason;
    this.deps.onLoad?.(reason, loadSeconds ?? null);
    this.deps.onLoadFailure?.(reason, error);
  }

  private pollAfter(startedAt: number) {
    return (
      startedAt + TAG_INDEX_POLL_MS + (this.deps.random ?? Math.random)() * TAG_INDEX_POLL_JITTER_MS
    );
  }

  private async refresh(gen: number, startedAt: number): Promise<void> {
    let loading: string | null = null;
    let loadStart = 0;
    try {
      const sql = this.deps.sql();
      const latest = await latestReadyManifest(sql, await this.deps.specHash());
      if (gen !== this.generation) return;
      if (!latest) {
        if (this.served) this.deps.onHeld?.(null);
        this.served = null;
        this.reason = 'no_snapshot';
      } else if (latest.id !== this.served?.id && latest.id !== this.rejected) {
        if (this.served && latest.payloadSha256 === this.served.payloadSha256) {
          // Another row naming the same bytes (a re-put after a retire): nothing to download.
          this.served = { ...this.served, id: latest.id, createdAt: latest.createdAt };
          this.deps.onHeld?.(identity(this.served));
        } else {
          loading = latest.id;
          loadStart = this.now();
          const { index } = await loadManifestSnapshot(
            { sql, objects: this.deps.objects(), decode: this.deps.decode },
            latest
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
          this.rejected = null;
          this.deps.onLoad?.('success', (this.now() - loadStart) / 1000);
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
          loading === null ? undefined : (this.now() - loadStart) / 1000
        );
    }
  }
}

let holder: TagIndexSnapshotHolder | undefined;

/**
 * The process's holder: the accessor P9's request path calls
 * (`await tagIndexSnapshotHolder().resolve()`). Constructing it allocates nothing of the index, and
 * the spec hash (computed over fixtures when `./spec` loads) and the decode worker's source are
 * imported only by a check, which runs only with the flag on.
 */
export function tagIndexSnapshotHolder(): TagIndexSnapshotHolder {
  return (holder ??= new TagIndexSnapshotHolder({
    enabled: () => isFlipt(FLIPT_FEATURE_FLAGS.RESOURCE_INTENT_TAG_INDEX_HOLDER),
    sql: () => coocSqlOf(dbRead),
    objects: () => s3TagIndexObjects(),
    decode: async (payload) => (await import('./decode-worker')).decodeTagIndexInWorker(payload),
    specHash: async () => (await import('./spec')).RESOURCE_INTENT_TAGS_SPEC_HASH,
    onLoad: recordTagIndexLoad,
    onHeld: setHeldTagIndex,
    onLoadFailure: (reason, error) => {
      logToAxiom(
        {
          type: 'resource-intent-tag-index-load-failed',
          reason,
          error: error instanceof Error ? error.message : String(error),
        },
        'temp-search'
      ).catch(() => undefined);
    },
  }));
}
