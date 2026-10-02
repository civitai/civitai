// Publishes the four App Blocks KV storage metrics at 0.
//
// prom-client materialises a child only on its first inc()/observe(), so a labelled counter
// that has never fired exposes no series — making "no app has hit a ceiling" and "the
// instrument is not wired" the same observation. Two of the four read that way in production.
//
// Imports the handles from `@civitai/telemetry/client` rather than the `~/server/prom/client`
// shim, matching `external-moderation.metrics.ts`: the shim builds the pg pool gauges at module
// load, and `src/__tests__/setup.ts` replaces it wholesale, which would make this untestable.
import {
  appStorageLatencyHistogram,
  appStorageOpsCounter,
  appStorageQuotaExceededCounter,
  appStorageUserQuotaUntrackedCounter,
} from '@civitai/telemetry/client';

/**
 * The five storage procedures. `app-storage.service.ts`'s `StorageOp` derives from this, so a
 * sixth op cannot be added there without being seeded here — unseeded, its series would be
 * absent until the first real call, which is the ambiguity above.
 */
export const APP_STORAGE_OPS = ['get', 'set', 'delete', 'list', 'getQuota'] as const;
export type AppStorageOp = (typeof APP_STORAGE_OPS)[number];

/** Emitted under any `op`, by `resolveStorageContext` / `countStorageFault` and each success path. */
export const APP_STORAGE_OUTCOMES_ALL_OPS = ['ok', 'unauthorized', 'not_found', 'error'] as const;

/**
 * Reachable only under `op: 'set'`. Kept out of the cross product because a seeded
 * `{op="list",outcome="quota_exceeded"}` is a zero no code path can move, which reads as "this
 * never happens" rather than "this cannot happen".
 */
export const APP_STORAGE_OUTCOMES_SET_ONLY = ['payload_too_large', 'quota_exceeded'] as const;

export type AppStorageOutcome =
  | (typeof APP_STORAGE_OUTCOMES_ALL_OPS)[number]
  | (typeof APP_STORAGE_OUTCOMES_SET_ONLY)[number];

export const APP_STORAGE_CEILINGS = ['app', 'user'] as const;

/** The 22 (op, outcome) pairs the service can emit: 5 x 4, plus `set` x 2. */
export const REACHABLE_OPS_SERIES: ReadonlyArray<{ op: AppStorageOp; outcome: AppStorageOutcome }> =
  APP_STORAGE_OPS.flatMap((op) => [
    ...APP_STORAGE_OUTCOMES_ALL_OPS.map((outcome) => ({
      op,
      outcome: outcome as AppStorageOutcome,
    })),
    ...(op === 'set'
      ? APP_STORAGE_OUTCOMES_SET_ONLY.map((outcome) => ({
          op,
          outcome: outcome as AppStorageOutcome,
        }))
      : []),
  ]);

/**
 * 🔴 Never call `Histogram.zero` unconditionally here. It REPLACES that label set's bucket
 * values (prom-client 14.2.0), and this runs on the first scrape rather than at pod start — so
 * an unconditional zero deletes every latency observation the pod served before being scraped.
 */
async function zeroMissingLatencyChildren(): Promise<void> {
  const { values } = await appStorageLatencyHistogram.get();
  const present = new Set(
    values.filter((v) => v.metricName?.endsWith('_count')).map((v) => v.labels.op)
  );
  for (const op of APP_STORAGE_OPS) {
    if (!present.has(op)) appStorageLatencyHistogram.zero({ op });
  }
}

/** Idempotent; safe to call on every scrape. */
export async function seedAppBlockStorageMetrics(): Promise<void> {
  try {
    for (const { op, outcome } of REACHABLE_OPS_SERIES) {
      appStorageOpsCounter.inc({ op, outcome }, 0);
    }

    // 🔴 `app_block_id` is deliberately OMITTED, not filled with a placeholder. Its domain is
    // unbounded, so there is nothing to enumerate; prom-client accepts a partial label set and
    // drops the unsupplied label, giving one row per `ceiling` whose `app_block_id` is empty.
    // It stays 0 forever — its only job is to make `absent()` mean "the instrument is gone".
    // Value aggregates are unaffected, but series aggregates are NOT: `count()`, `group by
    // (app_block_id)` and `topk` all see this row.
    for (const ceiling of APP_STORAGE_CEILINGS) {
      appStorageQuotaExceededCounter.inc({ ceiling }, 0);
    }
    appStorageUserQuotaUntrackedCounter.inc(0);

    // Last, and after the two counters that have an alerting consumer: this is the only leg
    // that can throw on a registry whose shape changed under us.
    await zeroMissingLatencyChildren();
  } catch {
    // Seeding is a readability nicety; losing it must not cost the scrape.
  }
}
