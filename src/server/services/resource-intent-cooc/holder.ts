import { dbRead } from '~/server/db/client';
import { logToAxiom } from '~/server/logging/client';
import { withTimeoutFallback } from '~/server/utils/timeout-helpers';
import { loadScores, type CoocScores } from './score';
import { RESOURCE_INTENT_COOC_SPEC, RESOURCE_INTENT_COOC_SPEC_HASH } from './spec';
import {
  CoocSnapshotExpiredError,
  coocSqlOf,
  latestReadySnapshotId,
  loadCoocSnapshot,
  type CoocSnapshotKind,
  type CoocSql,
} from './store';

/**
 * In-process holder for the co-occurrence snapshot the request path serves.
 *
 * Production: the newest ready production snapshot (`latestReadySnapshotId`), re-checked at most
 * every `COOC_SNAPSHOT_POLL_MS`, loaded once per change and shared by every request. Concurrent
 * callers share one in-flight check. Once a snapshot is held, a check never blocks a request.
 *
 * Study: a pinned study snapshot by content hash, refused once its pin passes.
 */

export const COOC_SNAPSHOT_POLL_MS = 5 * 60_000;
/** Spreads pods' polls so a new build is not fetched by every pod in the same instant. */
export const COOC_SNAPSHOT_POLL_JITTER_MS = 60_000;
/** A failed check is retried this long after it failed, sooner than the poll. */
export const COOC_SNAPSHOT_RETRY_MS = 60_000;
/** A check still running after this is abandoned as failed; a late result is discarded. */
export const COOC_SNAPSHOT_LOAD_TIMEOUT_MS = 120_000;
/**
 * With nothing held, requests arriving in a load's first 10 s wait for it (up to 10 s); once that
 * window has passed without a result, later requests get the fallback at once.
 */
export const COOC_FIRST_LOAD_WAIT_MS = 10_000;
const STUDY_SNAPSHOTS_HELD = 2;

export type CoocFallbackReason = 'no_snapshot' | 'load_failed' | 'spec_mismatch' | 'loading';
export type ServedCooc = { contentHash: string; scores: CoocScores };
export type CoocServing =
  | { snapshot: ServedCooc; fallbackReason: null }
  | { snapshot: null; fallbackReason: CoocFallbackReason };

export class CoocSpecMismatchError extends Error {
  constructor(readonly contentHash: string) {
    super(`cooc snapshot ${contentHash} was built under another spec`);
  }
}

type Loaded = ServedCooc & { pinnedUntil: Date | null };

/** Load and score a ready snapshot, refusing one built under a different cooc spec. */
async function loadServable(
  sql: CoocSql,
  contentHash: string,
  kind: CoocSnapshotKind,
  now: Date
): Promise<Loaded> {
  const { meta, counts } = await loadCoocSnapshot(sql, contentHash, { kind, now });
  if (meta.specHash !== RESOURCE_INTENT_COOC_SPEC_HASH)
    throw new CoocSpecMismatchError(contentHash);
  return {
    contentHash,
    scores: loadScores(counts, { beta: RESOURCE_INTENT_COOC_SPEC.beta }),
    pinnedUntil: meta.pinnedUntil,
  };
}

type HolderDeps = {
  sql: () => CoocSql;
  now?: () => number;
  /** In [0, 1); scales the poll jitter. */
  random?: () => number;
  onLoadFailure?: (reason: CoocFallbackReason, error: unknown) => void;
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

export class CoocSnapshotHolder {
  private served: ServedCooc | null = null;
  private reason: CoocFallbackReason = 'loading';
  private rejected: string | null = null;
  private nextCheckAt = -Infinity;
  private flight: Flight | null = null;
  private generation = 0;

  constructor(private readonly deps: HolderDeps) {}

  private now() {
    return (this.deps.now ?? Date.now)();
  }

  async resolve(): Promise<CoocServing> {
    if (!this.flight && this.now() >= this.nextCheckAt) this.flight = this.startCheck();
    const flight = this.flight;
    if (!this.served && flight) {
      if (!flight.waitSpent) {
        const wait = delay(COOC_FIRST_LOAD_WAIT_MS);
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

  private startCheck(): Flight {
    const gen = ++this.generation;
    const startedAt = this.now();
    const done = withTimeoutFallback<void | typeof TIMED_OUT>(
      this.refresh(gen, startedAt),
      COOC_SNAPSHOT_LOAD_TIMEOUT_MS,
      TIMED_OUT
    )
      .then((result) => {
        if (result !== TIMED_OUT || gen !== this.generation) return;
        this.generation++;
        this.fail(new Error('cooc snapshot check timed out'), this.now());
      })
      .finally(() => {
        if (this.flight?.done === done) this.flight = null;
      });
    return { done, waitSpent: false };
  }

  /** `at`: when the failure was observed, which the retry is measured from. */
  private fail(error: unknown, at: number) {
    const mismatch = error instanceof CoocSpecMismatchError;
    const reason: CoocFallbackReason = mismatch ? 'spec_mismatch' : 'load_failed';
    // Re-reading cannot fix a spec mismatch, only a new build can: remember it, keep the poll.
    if (mismatch) this.rejected = error.contentHash;
    this.nextCheckAt = mismatch ? this.pollAfter(at) : at + COOC_SNAPSHOT_RETRY_MS;
    if (!this.served) this.reason = reason;
    this.deps.onLoadFailure?.(reason, error);
  }

  private pollAfter(startedAt: number) {
    return (
      startedAt +
      COOC_SNAPSHOT_POLL_MS +
      (this.deps.random ?? Math.random)() * COOC_SNAPSHOT_POLL_JITTER_MS
    );
  }

  /** On a failed load a held snapshot stays served; it was valid for this code when loaded. */
  private async refresh(gen: number, startedAt: number): Promise<void> {
    try {
      const sql = this.deps.sql();
      const latest = await latestReadySnapshotId(sql);
      if (gen !== this.generation) return;
      if (!latest) {
        this.served = null;
        this.reason = 'no_snapshot';
      } else if (latest !== this.served?.contentHash && latest !== this.rejected) {
        const { contentHash, scores } = await loadServable(
          sql,
          latest,
          'production',
          new Date(startedAt)
        );
        if (gen !== this.generation) return;
        this.served = { contentHash, scores };
        this.rejected = null;
      }
      this.nextCheckAt = this.pollAfter(startedAt);
    } catch (error) {
      if (gen === this.generation) this.fail(error, this.now());
    }
  }
}

/**
 * Study snapshots by content hash, the last `STUDY_SNAPSHOTS_HELD` kept loaded. Throws (the
 * request fails closed) on a missing, non-study, spec-mismatched or expired snapshot.
 */
export class CoocStudySnapshots {
  private readonly held = new Map<string, Promise<Loaded>>();

  constructor(private readonly deps: { sql: () => CoocSql }) {}

  async get(contentHash: string, now: Date): Promise<ServedCooc> {
    let loading = this.held.get(contentHash);
    if (!loading) {
      loading = loadServable(this.deps.sql(), contentHash, 'study', now);
      this.held.set(contentHash, loading);
      const settled = loading;
      settled.catch(() => {
        if (this.held.get(contentHash) === settled) this.held.delete(contentHash);
      });
      for (const key of this.held.keys()) {
        if (this.held.size <= STUDY_SNAPSHOTS_HELD) break;
        this.held.delete(key);
      }
    }
    const loaded = await loading;
    if (!loaded.pinnedUntil || loaded.pinnedUntil.getTime() <= now.getTime())
      throw new CoocSnapshotExpiredError(`cooc study snapshot ${contentHash}: pin has passed`);
    return { contentHash: loaded.contentHash, scores: loaded.scores };
  }
}

let holder: CoocSnapshotHolder | undefined;
let studies: CoocStudySnapshots | undefined;

export function coocSnapshotHolder(): CoocSnapshotHolder {
  return (holder ??= new CoocSnapshotHolder({
    sql: () => coocSqlOf(dbRead),
    onLoadFailure: (reason, error) => {
      logToAxiom(
        {
          type: 'resource-intent-cooc-load-failed',
          reason,
          error: error instanceof Error ? error.message : String(error),
        },
        'temp-search'
      ).catch(() => undefined);
    },
  }));
}

export function coocStudySnapshots(): CoocStudySnapshots {
  return (studies ??= new CoocStudySnapshots({ sql: () => coocSqlOf(dbRead) }));
}
