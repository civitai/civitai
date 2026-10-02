// ZERO-SEEDING for the four App Blocks KV storage metrics.
//
// The metrics themselves are DECLARED in `@civitai/telemetry` (see
// `appStorageOpsCounter` and its three neighbours in
// `packages/civitai-telemetry/src/client.ts`) because the service imports them
// through the `~/server/prom/client` shim. This module owns the other half:
// publishing their series at 0 so an absent series means "not wired" rather
// than "wired, never fired".
//
// 🔴 WHY THIS IS NOT COSMETIC. prom-client materialises a child only on its
// first `inc()`/`observe()`, so a LABELLED counter that has never fired exposes
// no series at all — only `# HELP`/`# TYPE`, which Prometheus does not turn
// into a series. Measured against production on 2026-10-01:
// `…_storage_ops_total` had 110 series, while
// `…_storage_quota_exceeded_total` and
// `…_storage_user_quota_untracked_total` were ABSENT — not because the
// instrument was broken, but because nothing had ever incremented them. Those
// two readings are indistinguishable from the outside, and the second counter's
// whole stated purpose is to be alerted on ("some app has been running with its
// per-user sub-budget unenforced"). An alert cannot be written against a series
// that may legitimately not exist: `absent()` fires on a healthy fleet, and
// `> 0` never fires on a dead instrument. That ambiguity has already produced
// one wrong conclusion about this metric family.
//
// Imports the metric handles from `@civitai/telemetry/client` DIRECTLY rather
// than through `~/server/prom/client`, matching `external-moderation.metrics.ts`
// and `model-moderation.metrics.ts`. Both register onto the same prom-client
// default registry that /api/metrics scrapes, so the choice is invisible in the
// output — but the shim constructs the pg pool gauges at module load, and it is
// the module `src/__tests__/setup.ts` replaces wholesale with stubs. Going
// direct keeps the import graph light AND lets this module's tests read the
// REAL registry, which is the only place a metric-NAME defect is visible at all.
import {
  appStorageLatencyHistogram,
  appStorageOpsCounter,
  appStorageQuotaExceededCounter,
  appStorageUserQuotaUntrackedCounter,
} from '@civitai/telemetry/client';

/**
 * The five storage procedures, and the SINGLE SOURCE OF TRUTH for them.
 *
 * `app-storage.service.ts` derives its own `StorageOp` from this array with a
 * type-only import, rather than restating the union. The direction is
 * deliberate: a restatement is what drifts, and the drift here is silent —
 * a sixth op would simply never be seeded, so its series would be absent until
 * the first real call, which is the exact defect this module exists to remove.
 * A type-only import is erased at build, so the service gains no runtime edge
 * to this module and this module gains none to the service.
 */
export const APP_STORAGE_OPS = ['get', 'set', 'delete', 'list', 'getQuota'] as const;
export type AppStorageOp = (typeof APP_STORAGE_OPS)[number];

/**
 * Outcomes reachable on EVERY op.
 *
 * `unauthorized`, `not_found` and `error` all come out of the shared
 * `resolveStorageContext` / `countStorageFault` pair in
 * `app-storage.service.ts`, which every one of the five procedures calls with
 * its own `op`; `ok` is emitted by each procedure's success path.
 */
export const APP_STORAGE_OUTCOMES_ALL_OPS = ['ok', 'unauthorized', 'not_found', 'error'] as const;

/**
 * Outcomes only the `set` path can produce — the wire-size cap and the two
 * storage ceilings. Kept separate rather than folded into a full cross product
 * because seeding `{op="list",outcome="quota_exceeded"}` would put a permanent
 * zero on screen that NO code path can ever move, which reads as "this never
 * happens" when it means "this cannot happen".
 */
export const APP_STORAGE_OUTCOMES_SET_ONLY = ['payload_too_large', 'quota_exceeded'] as const;

export type AppStorageOutcome =
  | (typeof APP_STORAGE_OUTCOMES_ALL_OPS)[number]
  | (typeof APP_STORAGE_OUTCOMES_SET_ONLY)[number];

/** The two storage ceilings `block_storage_quota_exceeded_total` distinguishes. */
export const APP_STORAGE_CEILINGS = ['app', 'user'] as const;

/**
 * Every (op, outcome) pair the service can actually emit: 5 × 4 common, plus
 * `set` × 2 set-only = 22 series. Derived rather than written out, so adding an
 * op or an outcome extends it automatically.
 */
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
 * 🔴 ONCE-ONLY, AND PINNED ON globalThis — NOT the "idempotent, safe to call per
 * request" shape its neighbours in `src/server/metrics/` use.
 *
 * `Histogram.zero(labels)` is DESTRUCTIVE: prom-client replaces that label
 * set's bucket values wholesale rather than leaving an existing child alone.
 * Measured against prom-client 14.2.0 — `zero({op:'get'})`, `observe(0.5)`,
 * `zero({op:'get'})` leaves `…_count{op="get"}` at **0**, i.e. a real
 * observation is deleted. (`Counter.inc(labels, 0)` is additive and genuinely
 * idempotent; only the histogram is unsafe. `seedJobMetrics` in the telemetry
 * package carries a `Set` guard for the same reason.)
 *
 * globalThis rather than a module-scope `let` because Next.js re-evaluates a
 * module on hot reload while prom-client's registry survives in the same
 * process — a module-local flag would reset and the next call would wipe every
 * latency observation collected since boot. The real V8 global is also what
 * makes the flag safe across webpack graphs, the same mechanism
 * `collectMetricsInitialized` in `src/pages/api/metrics.ts` relies on.
 */
declare global {
  // eslint-disable-next-line no-var
  var __civitaiAppBlockStorageMetricsSeeded: boolean | undefined;
}

export function seedAppBlockStorageMetrics(): void {
  if (globalThis.__civitaiAppBlockStorageMetricsSeeded) return;
  globalThis.__civitaiAppBlockStorageMetricsSeeded = true;

  for (const { op, outcome } of REACHABLE_OPS_SERIES) {
    appStorageOpsCounter.inc({ op, outcome }, 0);
  }

  for (const op of APP_STORAGE_OPS) {
    appStorageLatencyHistogram.zero({ op });
  }

  // 🔴 PRESENCE BEACONS, not real series — and the distinction is the point.
  //
  // Both of these counters are labelled by `app_block_id`, which is unbounded:
  // there is no finite set of label values to seed, and inventing one would
  // either be wrong tomorrow or blow the cardinality budget. prom-client
  // accepts a PARTIAL label set (`validateLabel` rejects unknown labels, never
  // missing ones) and omits the unsupplied label from the output, so these emit
  //   civitai_app_block_storage_quota_exceeded_total{ceiling="app"} 0
  //   civitai_app_block_storage_user_quota_untracked_total 0
  // i.e. a row whose `app_block_id` is the empty string. Verified against
  // prom-client 14.2.0, and asserted in this module's test.
  //
  // That row will stay at 0 forever by construction — no emit site omits
  // `app_block_id`. It exists so `absent(<metric>)` means "the instrument is
  // gone" instead of "no app has hit a ceiling yet", which is the one question
  // these two counters were added to answer. Aggregates are unaffected:
  // `sum(...)` and `sum by (ceiling) (...)` add 0, and `> 0` alerts never see it.
  for (const ceiling of APP_STORAGE_CEILINGS) {
    appStorageQuotaExceededCounter.inc({ ceiling }, 0);
  }
  appStorageUserQuotaUntrackedCounter.inc(0);
}
