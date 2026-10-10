import { dbRead } from '~/server/db/client';
import { logToAxiom } from '~/server/logging/client';
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
/** A failed check is retried sooner than the poll. */
export const COOC_SNAPSHOT_RETRY_MS = 60_000;
/** How long a request waits for the first load before serving the fallback. */
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
  onLoadFailure?: (reason: CoocFallbackReason, error: unknown) => void;
};

const TIMED_OUT = Symbol('timed-out');

export class CoocSnapshotHolder {
  private served: ServedCooc | null = null;
  private reason: CoocFallbackReason = 'loading';
  private rejected: string | null = null;
  private nextCheckAt = -Infinity;
  private inflight: Promise<void> | null = null;

  constructor(private readonly deps: HolderDeps) {}

  private now() {
    return (this.deps.now ?? Date.now)();
  }

  async resolve(): Promise<CoocServing> {
    if (!this.inflight && this.now() >= this.nextCheckAt) {
      this.inflight = this.refresh().finally(() => {
        this.inflight = null;
      });
    }
    if (!this.served && this.inflight) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const waited = await Promise.race([
        this.inflight,
        new Promise<typeof TIMED_OUT>((res) => {
          timer = setTimeout(() => res(TIMED_OUT), COOC_FIRST_LOAD_WAIT_MS);
        }),
      ]);
      clearTimeout(timer);
      if (waited === TIMED_OUT && !this.served)
        return { snapshot: null, fallbackReason: 'loading' };
    }
    return this.served
      ? { snapshot: this.served, fallbackReason: null }
      : { snapshot: null, fallbackReason: this.reason };
  }

  /** On a failed load a held snapshot stays served; it was valid for this code when loaded. */
  private async refresh(): Promise<void> {
    const startedAt = this.now();
    let retryAt = startedAt + COOC_SNAPSHOT_POLL_MS;
    try {
      const sql = this.deps.sql();
      const latest = await latestReadySnapshotId(sql);
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
        this.served = { contentHash, scores };
        this.rejected = null;
      }
    } catch (error) {
      const mismatch = error instanceof CoocSpecMismatchError;
      const reason: CoocFallbackReason = mismatch ? 'spec_mismatch' : 'load_failed';
      // Re-reading cannot fix a spec mismatch, only a new build can: remember it, keep the poll.
      if (mismatch) this.rejected = error.contentHash;
      else retryAt = startedAt + COOC_SNAPSHOT_RETRY_MS;
      if (!this.served) this.reason = reason;
      this.deps.onLoadFailure?.(reason, error);
    } finally {
      this.nextCheckAt = retryAt;
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
