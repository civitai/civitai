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
// The `ChallengeSource` DB enum, in full. Also the zero-emit key set for the single-label state
// gauges below — keep it and `normSource` sharing one array so the two can never drift.
export const SOURCE_VALUES = ['System', 'Mod', 'User'] as const;
const SOURCES = new Set<string>(SOURCE_VALUES);
const BUZZ_TYPES = new Set(['green', 'yellow']);
const SCAN_RESULTS = new Set(['scanned', 'blocked', 'error']);
const STATUSES = new Set(['Scheduled', 'Active', 'Completing', 'Completed', 'Cancelled']);
const VOID_REASONS = new Set(['moderator', 'nsfw', 'activation']);
const REFUND_REASONS = new Set(['void', 'delete']);
const DIVERGENCE_FIELDS = new Set(['place', 'prize', 'both']);

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
export function normDivergenceField(v: string | null | undefined): string {
  return v && DIVERGENCE_FIELDS.has(v) ? v : 'other';
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
// ATTEMPTED, not settled — do not read this as "Buzz that reached winners". The emit sites sum the
// winner prizes SUBMITTED to `createBuzzTransactionMany`, which silently drops any non-success,
// non-conflict result (notably insufficientFunds) from both of its result arrays: the money did not
// move and is otherwise invisible. There is no per-leg settlement signal to filter on, so the sum is
// counted as submitted. Treat a gap vs the Buzz ledger as expected, not as an instrumentation bug.
const prizePaidBuzzCounter = registerCounterWithLabels({
  name: 'challenge_prize_paid_buzz_total',
  help: 'Buzz submitted for challenge winner-prize payouts (ATTEMPTED, not confirmed-settled: non-success legs such as insufficientFunds are dropped upstream and still counted), by source and buzzType',
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
// Money-path anomaly. A winner-prize payout is deduped only by its externalTransactionId, which
// embeds the place — so a winner re-picked at a different place than the one already recorded would
// pay twice. Any non-zero value means a completion re-picked winners over an existing record and
// the payout had to be reconciled onto the stored placement. Expected to sit flat at zero.
const winnerPlaceDivergenceCounter = registerCounterWithLabels({
  name: 'challenge_winner_place_divergence_total',
  help: 'ChallengeWinner inserts that conflicted with a stored row holding a different place/prize; the payout was reconciled to the stored placement (expected to stay at zero)',
  labelNames: ['field'] as const,
});
// Money-path anomaly, and DELIBERATELY NOT folded into the divergence counter above. That one means
// "a stored row disagreed with a re-pick" — a cross-run anomaly whose remediation is to work out why
// a completion ran twice. This one means "one winner-pick named the same creator in more than one
// slot", a judging-quality anomaly whose remediation is the prompt/model. Same metric, and an
// operator reading a non-zero value could not tell which had happened, nor could an alert on one
// avoid firing on the other.
//
// A creator can only ever hold ONE ChallengeWinner row per challenge — (challengeId, userId) is the
// table's unique key — so a second placement for the same creator is never payable, and the extra
// entries are dropped before the payout is built. Expected to sit flat at zero.
const winnerDuplicatePickCounter = registerCounterWithLabels({
  name: 'challenge_winner_duplicate_pick_total',
  help: 'Winner placements dropped before payout because the same creator held more than one place in a single pick (expected to stay at zero)',
  // `origin` separates the two layers that can drop, and it exists because `source` cannot do the
  // job: `normSource` routes both enum drift AND a null source (the caller reads its source off a
  // row typed `| undefined`) into `unknown`, so `source: unknown` alone cannot distinguish "the
  // choke point caught what a caller missed" from "a caller emitted without a readable source".
  // Those want different responses, so they get different label values rather than a shared bucket.
  labelNames: ['source', 'origin'] as const,
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

export function recordChallengeWinnerPlaceDivergence(args: { field: 'place' | 'prize' | 'both' }) {
  try {
    winnerPlaceDivergenceCounter.inc({ field: normDivergenceField(args.field) });
  } catch {
    /* never throw from telemetry */
  }
}

/**
 * `count` = how many placements were dropped, not how many picks contained a duplicate.
 *
 * An explicit `count: 0` records NOTHING. This counter is documented as sitting flat at zero and is
 * an alert trigger, so "I dropped nothing" must never read as "I dropped one" — an omitted `count`
 * still defaults to 1, which is the only case where 1 is the honest answer.
 */
export function recordChallengeWinnerDuplicatePick(args: {
  source?: string | null;
  count?: number;
  origin: 'caller' | 'chokepoint';
}) {
  try {
    if (args.count === 0) return;
    const count = isPositiveFinite(args.count) ? args.count : 1;
    winnerDuplicatePickCounter.inc(
      { source: normSource(args.source), origin: args.origin },
      count
    );
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

/**
 * ZERO-EMIT — why the single-label gauges pre-seed every known source with 0.
 *
 * A `GROUP BY` returns NO ROW for a count of zero, so a gauge that only `.set()`s the returned rows
 * emits NO SERIES while everything is healthy. That is indistinguishable from "the instrumentation
 * died": every alert on such a gauge fails open, and a dashboard reading it over different windows
 * reports different answers (absent over 1h, `1` over 12h) purely because the series only exists for
 * the ~1min the count was non-zero.
 *
 * So: seed `0` for every `ChallengeSource` FIRST, then overlay the query rows (a real row wins).
 * Applied to the three single-label gauges — `ingestion_pending`, `completing_stuck`,
 * `operation_budget_used_ratio` — which are precisely the "should be zero" health signals where
 * healthy-zero vs no-data is the distinction that matters.
 *
 * DELIBERATELY NOT applied to `challenge_by_status`: it is a descriptive inventory gauge, not an
 * alert source, and zero-filling it means the full source×status cross-product — 15 series/pod
 * instead of the ~7 actually populated, on the one gauge that is ALREADY this module's cardinality
 * problem (these gauges run on every web pod behind the 45s memo; see the GATING note above). A
 * dashboard for it aggregates with `sum()`, which handles an absent zero-count bucket correctly.
 * Cost of the choice made here: 3 sources × 3 gauges = 9 series/pod. The cross-product option would
 * have added 15 more on top of that, per pod.
 *
 * `unknown` is not pre-seeded — it only exists if the DB hands back a value outside the enum, and a
 * permanent `unknown=0` on every pod would be pure noise.
 */
function zeroFillKnownSources(gauge: {
  set(labels: Record<string, string>, value: number): void;
}): void {
  for (const source of SOURCE_VALUES) gauge.set({ source }, 0);
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
      zeroFillKnownSources(this);
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
      zeroFillKnownSources(this);
      for (const row of challengeGaugeCache.completingStuck)
        this.set({ source: normSource(row.source) }, row.count);
    },
  });
  // 🔴 READ BEFORE ALERTING ON THIS GAUGE. `operationBudget` is `Int @default(0)` and NOTHING in
  // the product sets it today — every Challenge row carries budget 0, while `operationSpent` is
  // genuinely non-zero. The query's `NULLIF(SUM("operationBudget"), 0)` therefore yields NULL, the
  // row is dropped, and before the zero-emit below this gauge produced no series at all. That was
  // never an emit bug — it is faithfully reporting "there is no budget to be a ratio of".
  //
  // Consequence: a `0` here means "no budget configured", NOT "budget healthy". A cost-control
  // alert of the shape `ratio > 0.8` can never fire while budgets are unset, so it would fail open
  // exactly like the missing series did. Gate any such alert on budgets actually being set (or
  // alert on absolute `challenge_operation_spent_buzz_total` instead) until the product writes a
  // non-zero `operationBudget`.
  new client.Gauge({
    name: 'civitai_app_challenge_operation_budget_used_ratio',
    help: 'SUM(operationSpent)/SUM(operationBudget) over Active+Completing challenges, by source (0 also means "no operationBudget set" — see the note in challenge.metrics.ts)',
    labelNames: ['source'],
    collect() {
      maybeRefreshChallengeGauges();
      this.reset();
      zeroFillKnownSources(this);
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
  // Both money-path anomaly counters were missing here. Counters live on a process-global registry,
  // so an un-reset one carries its value across every test in the file that touched it — a test
  // asserting "this stayed at zero" would pass or fail on execution ORDER rather than on behaviour,
  // which is precisely backwards for a metric whose whole contract is "expected to sit at zero".
  winnerPlaceDivergenceCounter.reset();
  winnerDuplicatePickCounter.reset();
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
