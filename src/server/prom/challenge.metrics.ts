import client from 'prom-client';
// Pure prom-client helpers (this import chain is prom-client-only — no env/DB), so the metric
// definitions + record helpers stay a runtime-light leaf that a unit test can load without booting
// the app graph. The DB used by the state gauges is pulled in LAZILY (dynamic import inside the
// gauge refresh) so importing this module never statically drags in pgDb/env.
import { registerCounterWithLabels } from '@civitai/telemetry/client';

/**
 * CHALLENGE observability (additive telemetry only — no behavior change).
 *
 * Prometheus coverage for the user-created Challenge funnel + Buzz economy + live state. Every
 * metric is defined here and every emit site calls one of the never-throw `recordX()` helpers below,
 * so a telemetry failure can NEVER break challenge business logic (each helper try/catch-swallows).
 *
 * Metric names all get the shared `civitai_app_` prefix via `registerCounterWithLabels`, so e.g.
 * `challenge_created_total` is scraped as `civitai_app_challenge_created_total`.
 *
 * CARDINALITY: every label is normalized against a fixed allowed set INSIDE the record helpers —
 * an unrecognized value maps to `'unknown'` (or `'other'` for reasons). Raw/free-text is never
 * passed into a label, so the series count is bounded by construction.
 */

// ---------------------------------------------------------------------------
// Label normalization (enum-bound — never emit raw/free-text)
// ---------------------------------------------------------------------------
const SOURCES = new Set(['System', 'Mod', 'User']);
const BUZZ_TYPES = new Set(['green', 'yellow']);
const SCAN_RESULTS = new Set(['scanned', 'blocked', 'error']);
const STATUSES = new Set(['Scheduled', 'Active', 'Completing', 'Completed', 'Cancelled']);
const VOID_REASONS = new Set(['moderator', 'nsfw', 'activation']);
const REFUND_REASONS = new Set(['void', 'delete']);

export function normSource(v: string | null | undefined): string {
  return v && SOURCES.has(v) ? v : 'unknown';
}
export function normBuzzType(v: string | null | undefined): string {
  return v && BUZZ_TYPES.has(v) ? v : 'unknown';
}
export function normScanResult(v: string | null | undefined): string {
  // A scan callback resolves to exactly one of these; an unexpected value is bucketed as 'error'
  // (the safe catch-all) rather than a new unbounded label.
  return v && SCAN_RESULTS.has(v) ? v : 'error';
}
export function normStatus(v: string | null | undefined): string {
  return v && STATUSES.has(v) ? v : 'unknown';
}
export function normPaid(paid: boolean | null | undefined): '0' | '1' {
  return paid ? '1' : '0';
}
export function normVoidReason(v: string | null | undefined): string {
  return v && VOID_REASONS.has(v) ? v : 'other';
}
export function normRefundReason(v: string | null | undefined): string {
  return v && REFUND_REASONS.has(v) ? v : 'other';
}

// ---------------------------------------------------------------------------
// A. Funnel counters
// ---------------------------------------------------------------------------
const createdCounter = registerCounterWithLabels({
  name: 'challenge_created_total',
  help: 'User-created challenges created, by source and buzzType (create path only, not edits)',
  labelNames: ['source', 'buzzType'] as const,
});
const scanResultCounter = registerCounterWithLabels({
  name: 'challenge_scan_result_total',
  help: 'Challenge text-moderation scan outcomes by source and result (scanned=not-blocked verdict, blocked=ToS block, error=submit/terminal scan failure)',
  labelNames: ['source', 'result'] as const,
});
const entrySubmittedCounter = registerCounterWithLabels({
  name: 'challenge_entry_submitted_total',
  help: 'Challenge entries accepted into a contest collection, by source, buzzType and paid (1=entry fee charged, 0=free)',
  labelNames: ['source', 'buzzType', 'paid'] as const,
});
const reviewRequestedCounter = registerCounterWithLabels({
  name: 'challenge_review_requested_total',
  help: 'Paid AI-judge review requests that succeeded, by source',
  labelNames: ['source'] as const,
});
const completedCounter = registerCounterWithLabels({
  name: 'challenge_completed_total',
  help: 'Challenges that completed (winners picked or zero-winner completion), by source',
  labelNames: ['source'] as const,
});
const voidedCounter = registerCounterWithLabels({
  name: 'challenge_voided_total',
  help: 'Challenges voided/cancelled with a real refund (voided=true), by source and reason',
  labelNames: ['source', 'reason'] as const,
});
const deletedCounter = registerCounterWithLabels({
  name: 'challenge_deleted_total',
  help: 'User-created challenges deleted by their creator, by source',
  labelNames: ['source'] as const,
});

// ---------------------------------------------------------------------------
// B. Economy counters (`.inc(buzzAmount)`)
// ---------------------------------------------------------------------------
const entryFeesBuzzCounter = registerCounterWithLabels({
  name: 'challenge_entry_fees_buzz_total',
  help: 'Buzz charged for challenge entry fees (house + pool legs, first-time charges only), by source and buzzType',
  labelNames: ['source', 'buzzType'] as const,
});
const prizePaidBuzzCounter = registerCounterWithLabels({
  name: 'challenge_prize_paid_buzz_total',
  help: 'Buzz paid out to challenge winners (winner prizes), by source and buzzType',
  labelNames: ['source', 'buzzType'] as const,
});
const operationSpentBuzzCounter = registerCounterWithLabels({
  name: 'challenge_operation_spent_buzz_total',
  help: 'Buzz spent on AI judge/review operations (operationSpent increments), by source and buzzType',
  labelNames: ['source', 'buzzType'] as const,
});
const refundBuzzCounter = registerCounterWithLabels({
  name: 'challenge_refund_buzz_total',
  help: 'Buzz refunded on challenge void/delete (entry-fee pool + initial prize), by source, buzzType and reason',
  labelNames: ['source', 'buzzType', 'reason'] as const,
});
const refundFailuresCounter = registerCounterWithLabels({
  name: 'challenge_refund_failures_total',
  help: 'Challenge refund attempts that threw (non NOT_FOUND), by source and reason',
  labelNames: ['source', 'reason'] as const,
});

// ---------------------------------------------------------------------------
// Never-throw record helpers — called from business logic emit sites
// ---------------------------------------------------------------------------
function isPositiveFinite(n: number | null | undefined): n is number {
  return typeof n === 'number' && Number.isFinite(n) && n > 0;
}

export function recordChallengeCreated(args: { source?: string | null; buzzType?: string | null }) {
  try {
    createdCounter.inc({ source: normSource(args.source), buzzType: normBuzzType(args.buzzType) });
  } catch {
    /* never throw from telemetry */
  }
}

export function recordChallengeScanResult(args: { source?: string | null; result: string }) {
  try {
    scanResultCounter.inc({ source: normSource(args.source), result: normScanResult(args.result) });
  } catch {
    /* never throw from telemetry */
  }
}

export function recordChallengeEntrySubmitted(args: {
  source?: string | null;
  buzzType?: string | null;
  paid?: boolean | null;
  count?: number;
}) {
  try {
    const count = isPositiveFinite(args.count) ? args.count : 1;
    entrySubmittedCounter.inc(
      {
        source: normSource(args.source),
        buzzType: normBuzzType(args.buzzType),
        paid: normPaid(args.paid),
      },
      count
    );
  } catch {
    /* never throw from telemetry */
  }
}

export function recordChallengeReviewRequested(args: { source?: string | null }) {
  try {
    reviewRequestedCounter.inc({ source: normSource(args.source) });
  } catch {
    /* never throw from telemetry */
  }
}

export function recordChallengeCompleted(args: { source?: string | null }) {
  try {
    completedCounter.inc({ source: normSource(args.source) });
  } catch {
    /* never throw from telemetry */
  }
}

export function recordChallengeVoided(args: { source?: string | null; reason?: string | null }) {
  try {
    voidedCounter.inc({ source: normSource(args.source), reason: normVoidReason(args.reason) });
  } catch {
    /* never throw from telemetry */
  }
}

export function recordChallengeDeleted(args: { source?: string | null }) {
  try {
    deletedCounter.inc({ source: normSource(args.source) });
  } catch {
    /* never throw from telemetry */
  }
}

export function recordChallengeEntryFeesBuzz(args: {
  source?: string | null;
  buzzType?: string | null;
  amount: number;
}) {
  try {
    if (!isPositiveFinite(args.amount)) return;
    entryFeesBuzzCounter.inc(
      { source: normSource(args.source), buzzType: normBuzzType(args.buzzType) },
      args.amount
    );
  } catch {
    /* never throw from telemetry */
  }
}

export function recordChallengePrizePaidBuzz(args: {
  source?: string | null;
  buzzType?: string | null;
  amount: number;
}) {
  try {
    if (!isPositiveFinite(args.amount)) return;
    prizePaidBuzzCounter.inc(
      { source: normSource(args.source), buzzType: normBuzzType(args.buzzType) },
      args.amount
    );
  } catch {
    /* never throw from telemetry */
  }
}

export function recordChallengeOperationSpentBuzz(args: {
  source?: string | null;
  buzzType?: string | null;
  amount: number;
}) {
  try {
    if (!isPositiveFinite(args.amount)) return;
    operationSpentBuzzCounter.inc(
      { source: normSource(args.source), buzzType: normBuzzType(args.buzzType) },
      args.amount
    );
  } catch {
    /* never throw from telemetry */
  }
}

export function recordChallengeRefundBuzz(args: {
  source?: string | null;
  buzzType?: string | null;
  reason?: string | null;
  amount: number;
}) {
  try {
    if (!isPositiveFinite(args.amount)) return;
    refundBuzzCounter.inc(
      {
        source: normSource(args.source),
        buzzType: normBuzzType(args.buzzType),
        reason: normRefundReason(args.reason),
      },
      args.amount
    );
  } catch {
    /* never throw from telemetry */
  }
}

export function recordChallengeRefundFailure(args: {
  source?: string | null;
  reason?: string | null;
}) {
  try {
    refundFailuresCounter.inc({
      source: normSource(args.source),
      reason: normRefundReason(args.reason),
    });
  } catch {
    /* never throw from telemetry */
  }
}

// ---------------------------------------------------------------------------
// C. State gauges (async collect(), low cardinality, memoized ~45s)
// ---------------------------------------------------------------------------
// The Challenge table is small (thousands of rows, not the Image-table millions), so the four
// GROUP BYs are cheap — but /metrics is scraped ~15s and there can be several scrapers/pod, so a
// single memoized read (TTL ~45s) refreshed lazily OFF the scrape path serves every gauge from
// last-known values. A scrape only ever kicks a background refresh, never blocks on it. A defensive
// statement_timeout caps a replica cold-cache spike; on any error we keep the last-good values.
//
// GATING: this repo exposes no clean pod-role / jobs-pool signal (only PODNAME, a bare pod name),
// so per the "don't invent a fragile gate" rule these gauges run on ALL pods behind the 45s memo.
// The read hits the replica pool (pgDbRead). Follow-up: gate to the -jobs pool if a role signal is
// added (e.g. an env POD_ROLE), so only a couple of pods query.
// Challenge table ~217 rows (2026-07), GROUP BYs are trivial seq/index scans; revisit fleet-wide
// gauge gating only if the table grows orders of magnitude. TTL 45s matches the proven in-prod
// image_ingestion_backlog gauge this pattern was modeled on.
const CHALLENGE_GAUGE_TTL_MS = 45_000;
const CHALLENGE_GAUGE_STATEMENT_TIMEOUT_MS = 5_000;
const COMPLETING_STUCK_MINUTES = 30;

type SourceCount = { source: string; count: number };
type SourceStatusCount = { source: string; status: string; count: number };
type SourceRatio = { source: string; ratio: number };

type ChallengeGaugeData = {
  byStatus: SourceStatusCount[];
  ingestionPending: SourceCount[];
  completingStuck: SourceCount[];
  budgetRatio: SourceRatio[];
};

let challengeGaugeCache: ChallengeGaugeData = {
  byStatus: [],
  ingestionPending: [],
  completingStuck: [],
  budgetRatio: [],
};
let challengeGaugeFetchedAt = 0;
let challengeGaugeInflight: Promise<void> | null = null;

async function queryChallengeGauges(): Promise<ChallengeGaugeData> {
  // Lazy import so this module stays DB-free until a real scrape needs the gauges (keeps the unit
  // test light and avoids booting pgDb/env at import time).
  const { pgDbRead } = await import('~/server/db/pgDb');
  const dbClient = await pgDbRead.connect();
  try {
    await dbClient.query('BEGIN');
    await dbClient.query(`SET LOCAL statement_timeout = ${CHALLENGE_GAUGE_STATEMENT_TIMEOUT_MS}`);

    const byStatus = await dbClient.query<{ source: string; status: string; count: string }>(
      `SELECT source::text AS source, status::text AS status, count(*)::text AS count
         FROM "Challenge" GROUP BY source, status`
    );
    const ingestionPending = await dbClient.query<{ source: string; count: string }>(
      `SELECT source::text AS source, count(*)::text AS count
         FROM "Challenge" WHERE ingestion = 'Pending' GROUP BY source`
    );
    const completingStuck = await dbClient.query<{ source: string; count: string }>(
      `SELECT source::text AS source, count(*)::text AS count
         FROM "Challenge"
        WHERE status = 'Completing'
          AND "updatedAt" < now() - interval '${COMPLETING_STUCK_MINUTES} minutes'
        GROUP BY source`
    );
    // Budget utilisation over challenges currently consuming their AI-review budget (Active or
    // mid-completion) — a finished/scheduled challenge's ratio isn't an operational signal.
    const budgetRatio = await dbClient.query<{ source: string; ratio: string | null }>(
      `SELECT source::text AS source,
              (SUM("operationSpent")::float / NULLIF(SUM("operationBudget"), 0)) AS ratio
         FROM "Challenge"
        WHERE status IN ('Active', 'Completing')
        GROUP BY source`
    );

    await dbClient.query('COMMIT');
    return {
      byStatus: byStatus.rows.map((r) => ({
        source: r.source,
        status: r.status,
        count: Number(r.count),
      })),
      ingestionPending: ingestionPending.rows.map((r) => ({
        source: r.source,
        count: Number(r.count),
      })),
      completingStuck: completingStuck.rows.map((r) => ({
        source: r.source,
        count: Number(r.count),
      })),
      budgetRatio: budgetRatio.rows
        .filter((r) => r.ratio != null)
        .map((r) => ({ source: r.source, ratio: Number(r.ratio) })),
    };
  } catch (e) {
    await dbClient.query('ROLLBACK').catch(() => undefined);
    throw e;
  } finally {
    dbClient.release();
  }
}

function refreshChallengeGauges(): Promise<void> {
  if (challengeGaugeInflight) return challengeGaugeInflight;
  challengeGaugeInflight = queryChallengeGauges()
    .then((data) => {
      challengeGaugeCache = data;
      challengeGaugeFetchedAt = Date.now();
    })
    .catch(() => {
      // Swallow (incl. statement_timeout): keep last-known values so a DB hiccup can't break the
      // /metrics scrape. A stale gauge beats a 500.
    })
    .finally(() => {
      challengeGaugeInflight = null;
    });
  return challengeGaugeInflight;
}

function maybeRefreshChallengeGauges() {
  if (Date.now() - challengeGaugeFetchedAt > CHALLENGE_GAUGE_TTL_MS) void refreshChallengeGauges();
}

declare global {
  // eslint-disable-next-line no-var
  var challengeGaugesInitialized: boolean | undefined;
}

if (!globalThis.challengeGaugesInitialized) {
  new client.Gauge({
    name: 'civitai_app_challenge_by_status',
    help: 'Challenges by source and status (live count)',
    labelNames: ['source', 'status'],
    collect() {
      maybeRefreshChallengeGauges();
      this.reset();
      for (const row of challengeGaugeCache.byStatus)
        this.set({ source: normSource(row.source), status: normStatus(row.status) }, row.count);
    },
  });
  new client.Gauge({
    name: 'civitai_app_challenge_ingestion_pending',
    help: 'Challenges awaiting a moderation scan (ingestion=Pending) by source',
    labelNames: ['source'],
    collect() {
      maybeRefreshChallengeGauges();
      this.reset();
      for (const row of challengeGaugeCache.ingestionPending)
        this.set({ source: normSource(row.source) }, row.count);
    },
  });
  new client.Gauge({
    name: 'civitai_app_challenge_completing_stuck',
    help: `Challenges stuck in status=Completing for more than ${COMPLETING_STUCK_MINUTES} minutes, by source`,
    labelNames: ['source'],
    collect() {
      maybeRefreshChallengeGauges();
      this.reset();
      for (const row of challengeGaugeCache.completingStuck)
        this.set({ source: normSource(row.source) }, row.count);
    },
  });
  new client.Gauge({
    name: 'civitai_app_challenge_operation_budget_used_ratio',
    help: 'SUM(operationSpent)/SUM(operationBudget) over Active+Completing challenges, by source',
    labelNames: ['source'],
    collect() {
      maybeRefreshChallengeGauges();
      this.reset();
      for (const row of challengeGaugeCache.budgetRatio)
        this.set({ source: normSource(row.source) }, row.ratio);
    },
  });
  globalThis.challengeGaugesInitialized = true;
}

// ---------------------------------------------------------------------------
// Test-only helpers
// ---------------------------------------------------------------------------
/** Reset all challenge counters between test cases. */
export function __resetChallengeMetricsForTest(): void {
  createdCounter.reset();
  scanResultCounter.reset();
  entrySubmittedCounter.reset();
  reviewRequestedCounter.reset();
  completedCounter.reset();
  voidedCounter.reset();
  deletedCounter.reset();
  entryFeesBuzzCounter.reset();
  prizePaidBuzzCounter.reset();
  operationSpentBuzzCounter.reset();
  refundBuzzCounter.reset();
  refundFailuresCounter.reset();
}

/**
 * Inject gauge cache values directly and mark them fresh, so the gauge `collect()` reads them
 * WITHOUT firing the background DB query. This is how the gauge test mocks the DB — it feeds the
 * exact rows a query would return and asserts the emitted series.
 */
export function __setChallengeGaugeCacheForTest(data: Partial<ChallengeGaugeData>): void {
  challengeGaugeCache = {
    byStatus: data.byStatus ?? [],
    ingestionPending: data.ingestionPending ?? [],
    completingStuck: data.completingStuck ?? [],
    budgetRatio: data.budgetRatio ?? [],
  };
  challengeGaugeFetchedAt = Date.now();
}
