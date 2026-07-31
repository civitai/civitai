import { describe, it, expect, beforeEach } from 'vitest';
import client from 'prom-client';
import {
  normSource,
  normBuzzType,
  normScanResult,
  normStatus,
  normPaid,
  normVoidReason,
  normRefundReason,
  normDivergenceField,
  recordChallengeWinnerDuplicatePick,
  recordChallengeWinnerPlaceDivergence,
  recordChallengeWinnerConflictUnresolved,
  recordChallengeCreated,
  recordChallengeScanResult,
  recordChallengeEntrySubmitted,
  recordChallengeReviewRequested,
  recordChallengeCompleted,
  recordChallengeVoided,
  recordChallengeDeleted,
  recordChallengeEntryFeesBuzz,
  recordChallengePrizePaidBuzz,
  recordChallengeOperationSpentBuzz,
  recordChallengeRefundBuzz,
  recordChallengeRefundFailure,
  __resetChallengeMetricsForTest,
  __setChallengeGaugeCacheForTest,
} from '~/server/prom/challenge.metrics';

// Pure unit test: challenge.metrics imports only prom-client + the prom-client-only telemetry
// helpers, and the state-gauge DB read is a LAZY dynamic import — so nothing here boots pgDb/env or
// the app graph. Counters are driven directly and read back off the default registry; the gauge
// test injects cache rows (mocking the DB) via __setChallengeGaugeCacheForTest and reads the
// collect()-emitted series.

type MetricJSON = { values: { value: number; labels: Record<string, string> }[] };

async function readMetric(name: string): Promise<MetricJSON['values']> {
  const metric = client.register.getSingleMetric(name) as unknown as {
    get: () => Promise<MetricJSON>;
  };
  const data = await metric.get();
  return data.values;
}

async function valueFor(name: string, labels: Record<string, string>): Promise<number> {
  const values = await readMetric(name);
  const match = values.find((v) => Object.entries(labels).every(([k, val]) => v.labels[k] === val));
  return match?.value ?? 0;
}

beforeEach(() => {
  __resetChallengeMetricsForTest();
});

describe('label normalizers — enum-bound, never raw/free-text', () => {
  it('normSource maps known → itself, everything else → unknown', () => {
    expect(normSource('System')).toBe('System');
    expect(normSource('Mod')).toBe('Mod');
    expect(normSource('User')).toBe('User');
    expect(normSource('Hacker')).toBe('unknown');
    expect(normSource(undefined)).toBe('unknown');
    expect(normSource(null)).toBe('unknown');
    expect(normSource('')).toBe('unknown');
  });

  it('normBuzzType bounds to green|yellow, else unknown', () => {
    expect(normBuzzType('green')).toBe('green');
    expect(normBuzzType('yellow')).toBe('yellow');
    expect(normBuzzType('blue')).toBe('unknown');
    expect(normBuzzType(undefined)).toBe('unknown');
  });

  it('normScanResult bounds to scanned|blocked|error, unknown → error', () => {
    expect(normScanResult('scanned')).toBe('scanned');
    expect(normScanResult('blocked')).toBe('blocked');
    expect(normScanResult('error')).toBe('error');
    expect(normScanResult('weird-verdict')).toBe('error');
    expect(normScanResult(undefined)).toBe('error');
  });

  it('normStatus bounds to the 5 ChallengeStatus values, else unknown', () => {
    for (const s of ['Scheduled', 'Active', 'Completing', 'Completed', 'Cancelled']) {
      expect(normStatus(s)).toBe(s);
    }
    expect(normStatus('Deleted')).toBe('unknown');
    expect(normStatus(null)).toBe('unknown');
  });

  it('normPaid returns 1 for truthy, 0 otherwise', () => {
    expect(normPaid(true)).toBe('1');
    expect(normPaid(false)).toBe('0');
    expect(normPaid(undefined)).toBe('0');
    expect(normPaid(null)).toBe('0');
  });

  it('normVoidReason bounds to moderator|nsfw|activation, free-text → other', () => {
    expect(normVoidReason('moderator')).toBe('moderator');
    expect(normVoidReason('nsfw')).toBe('nsfw');
    expect(normVoidReason('activation')).toBe('activation');
    expect(normVoidReason('because-i-said-so')).toBe('other');
    expect(normVoidReason(undefined)).toBe('other');
  });

  it('normRefundReason bounds to void|delete, everything else (incl. completion) → other', () => {
    expect(normRefundReason('void')).toBe('void');
    expect(normRefundReason('delete')).toBe('delete');
    expect(normRefundReason('completion')).toBe('other');
    expect(normRefundReason('anything')).toBe('other');
    expect(normRefundReason(undefined)).toBe('other');
  });
});

describe('funnel counters emit the expected series with normalized labels', () => {
  it('challenge_created_total labels source/buzzType (bad values → unknown)', async () => {
    recordChallengeCreated({ source: 'User', buzzType: 'yellow' });
    recordChallengeCreated({ source: 'User', buzzType: 'yellow' });
    recordChallengeCreated({ source: 'nope', buzzType: 'purple' });

    expect(
      await valueFor('civitai_app_challenge_created_total', { source: 'User', buzzType: 'yellow' })
    ).toBe(2);
    expect(
      await valueFor('civitai_app_challenge_created_total', {
        source: 'unknown',
        buzzType: 'unknown',
      })
    ).toBe(1);
  });

  it('challenge_scan_result_total buckets by result', async () => {
    recordChallengeScanResult({ source: 'User', result: 'scanned' });
    recordChallengeScanResult({ source: 'User', result: 'blocked' });
    recordChallengeScanResult({ source: 'System', result: 'error' });

    expect(
      await valueFor('civitai_app_challenge_scan_result_total', {
        source: 'User',
        result: 'scanned',
      })
    ).toBe(1);
    expect(
      await valueFor('civitai_app_challenge_scan_result_total', {
        source: 'User',
        result: 'blocked',
      })
    ).toBe(1);
    expect(
      await valueFor('civitai_app_challenge_scan_result_total', {
        source: 'System',
        result: 'error',
      })
    ).toBe(1);
  });

  it('challenge_entry_submitted_total increments by count with paid label', async () => {
    recordChallengeEntrySubmitted({ source: 'User', buzzType: 'green', paid: true, count: 3 });
    recordChallengeEntrySubmitted({ source: 'User', buzzType: 'green', paid: false, count: 2 });
    // default count = 1 when omitted / non-positive
    recordChallengeEntrySubmitted({ source: 'User', buzzType: 'yellow', paid: true });

    expect(
      await valueFor('civitai_app_challenge_entry_submitted_total', {
        source: 'User',
        buzzType: 'green',
        paid: '1',
      })
    ).toBe(3);
    expect(
      await valueFor('civitai_app_challenge_entry_submitted_total', {
        source: 'User',
        buzzType: 'green',
        paid: '0',
      })
    ).toBe(2);
    expect(
      await valueFor('civitai_app_challenge_entry_submitted_total', {
        source: 'User',
        buzzType: 'yellow',
        paid: '1',
      })
    ).toBe(1);
  });

  it('review/completed/voided/deleted counters emit', async () => {
    recordChallengeReviewRequested({ source: 'User' });
    recordChallengeCompleted({ source: 'System' });
    recordChallengeVoided({ source: 'User', reason: 'nsfw' });
    recordChallengeVoided({ source: 'User', reason: 'made-up' }); // → other
    recordChallengeDeleted({ source: 'User' });

    expect(
      await valueFor('civitai_app_challenge_review_requested_total', { source: 'User' })
    ).toBe(1);
    expect(await valueFor('civitai_app_challenge_completed_total', { source: 'System' })).toBe(1);
    expect(
      await valueFor('civitai_app_challenge_voided_total', { source: 'User', reason: 'nsfw' })
    ).toBe(1);
    expect(
      await valueFor('civitai_app_challenge_voided_total', { source: 'User', reason: 'other' })
    ).toBe(1);
    expect(await valueFor('civitai_app_challenge_deleted_total', { source: 'User' })).toBe(1);
  });
});

describe('economy counters — inc by buzz amount, skip non-positive', () => {
  it('entry fees / prize paid / operation spent sum by amount', async () => {
    recordChallengeEntryFeesBuzz({ source: 'User', buzzType: 'yellow', amount: 100 });
    recordChallengeEntryFeesBuzz({ source: 'User', buzzType: 'yellow', amount: 50 });
    recordChallengePrizePaidBuzz({ source: 'User', buzzType: 'green', amount: 5000 });
    recordChallengeOperationSpentBuzz({ source: 'System', buzzType: 'yellow', amount: 42 });

    expect(
      await valueFor('civitai_app_challenge_entry_fees_buzz_total', {
        source: 'User',
        buzzType: 'yellow',
      })
    ).toBe(150);
    expect(
      await valueFor('civitai_app_challenge_prize_paid_buzz_total', {
        source: 'User',
        buzzType: 'green',
      })
    ).toBe(5000);
    expect(
      await valueFor('civitai_app_challenge_operation_spent_buzz_total', {
        source: 'System',
        buzzType: 'yellow',
      })
    ).toBe(42);
  });

  it('non-positive / non-finite amounts are ignored (no series, no NaN)', async () => {
    recordChallengeEntryFeesBuzz({ source: 'User', buzzType: 'yellow', amount: 0 });
    recordChallengeEntryFeesBuzz({ source: 'User', buzzType: 'yellow', amount: -10 });
    recordChallengePrizePaidBuzz({ source: 'User', buzzType: 'yellow', amount: NaN });

    expect(await readMetric('civitai_app_challenge_entry_fees_buzz_total')).toHaveLength(0);
    expect(await readMetric('civitai_app_challenge_prize_paid_buzz_total')).toHaveLength(0);
  });

  it('refund buzz sums by reason; refund failures count by reason', async () => {
    recordChallengeRefundBuzz({ source: 'User', buzzType: 'yellow', reason: 'void', amount: 300 });
    recordChallengeRefundBuzz({ source: 'User', buzzType: 'yellow', reason: 'delete', amount: 75 });
    // 'completion' normalizes to 'other'
    recordChallengeRefundBuzz({
      source: 'User',
      buzzType: 'yellow',
      reason: 'completion',
      amount: 10,
    });
    recordChallengeRefundFailure({ source: 'User', reason: 'void' });
    recordChallengeRefundFailure({ source: 'User', reason: 'void' });

    expect(
      await valueFor('civitai_app_challenge_refund_buzz_total', {
        source: 'User',
        buzzType: 'yellow',
        reason: 'void',
      })
    ).toBe(300);
    expect(
      await valueFor('civitai_app_challenge_refund_buzz_total', {
        source: 'User',
        buzzType: 'yellow',
        reason: 'delete',
      })
    ).toBe(75);
    expect(
      await valueFor('civitai_app_challenge_refund_buzz_total', {
        source: 'User',
        buzzType: 'yellow',
        reason: 'other',
      })
    ).toBe(10);
    expect(
      await valueFor('civitai_app_challenge_refund_failures_total', {
        source: 'User',
        reason: 'void',
      })
    ).toBe(2);
  });
});

// The two money-path anomaly counters. Every other counter in this file is a volume signal where an
// off-by-one is noise; these are documented as sitting FLAT AT ZERO, so a unit that should not have
// been recorded is not a rounding error — it is the whole signal being wrong.
describe('money-path anomaly counters — a unit must mean exactly one real event', () => {
  /**
   * Absent series vs a series holding 0. `valueFor` above collapses both to 0, which is precisely
   * the distinction these counters live or die on, so they get their own reader.
   */
  async function seriesValue(
    name: string,
    labels: Record<string, string>
  ): Promise<number | undefined> {
    const values = await readMetric(name);
    return values.find((v) => Object.entries(labels).every(([k, val]) => v.labels[k] === val))
      ?.value;
  }

  const DUPLICATE_PICK = 'civitai_app_challenge_winner_duplicate_pick_total';
  const DIVERGENCE = 'civitai_app_challenge_winner_place_divergence_total';
  const UNRESOLVED = 'civitai_app_challenge_winner_conflict_unresolved_total';

  it('an explicit count of 0 records NOTHING — "I dropped nothing" must never read as one drop', async () => {
    recordChallengeWinnerDuplicatePick({ source: 'System', count: 0, origin: 'caller' });

    // Absent, not zero: the emit must not have happened at all. Without the guard the count falls
    // through to the `isPositiveFinite` default and this series reads 1 — a phantom dropped
    // placement, i.e. phantom unpaid money, on a counter whose contract is that it stays at zero.
    expect(
      await seriesValue(DUPLICATE_PICK, { source: 'System', origin: 'caller' })
    ).toBeUndefined();
    expect(await readMetric(DUPLICATE_PICK)).toHaveLength(0);
  });

  it('an explicitly garbage count records NOTHING either — negative, NaN and Infinity', async () => {
    // A caller that computed one of these has a bug; recording 1 for it invents a drop that did not
    // happen and hides the bug behind a plausible-looking value.
    recordChallengeWinnerDuplicatePick({ source: 'System', count: -1, origin: 'caller' });
    recordChallengeWinnerDuplicatePick({ source: 'System', count: NaN, origin: 'caller' });
    recordChallengeWinnerDuplicatePick({ source: 'System', count: Infinity, origin: 'caller' });

    expect(await readMetric(DUPLICATE_PICK)).toHaveLength(0);
  });

  it('an OMITTED count still means one drop — the default is not collateral damage of the guard', async () => {
    recordChallengeWinnerDuplicatePick({ source: 'System', origin: 'caller' });

    expect(await seriesValue(DUPLICATE_PICK, { source: 'System', origin: 'caller' })).toBe(1);
  });

  it('a real count is recorded verbatim, and origin/source are kept apart', async () => {
    recordChallengeWinnerDuplicatePick({ source: 'User', count: 2, origin: 'caller' });
    recordChallengeWinnerDuplicatePick({ count: 1, origin: 'chokepoint' });

    expect(await seriesValue(DUPLICATE_PICK, { source: 'User', origin: 'caller' })).toBe(2);
    // The choke point has no challenge in scope, so its source normalizes to `unknown` — the exact
    // ambiguity the `origin` label exists to resolve.
    expect(await seriesValue(DUPLICATE_PICK, { source: 'unknown', origin: 'chokepoint' })).toBe(1);
    expect(
      await seriesValue(DUPLICATE_PICK, { source: 'User', origin: 'chokepoint' })
    ).toBeUndefined();
  });

  it('normDivergenceField bounds to place|prize|both, else other', () => {
    expect(normDivergenceField('place')).toBe('place');
    expect(normDivergenceField('prize')).toBe('prize');
    expect(normDivergenceField('both')).toBe('both');
    expect(normDivergenceField('points')).toBe('other');
    expect(normDivergenceField(undefined)).toBe('other');
  });

  it('the divergence counter keeps its three field values separate', async () => {
    recordChallengeWinnerPlaceDivergence({ field: 'place' });
    recordChallengeWinnerPlaceDivergence({ field: 'prize' });
    recordChallengeWinnerPlaceDivergence({ field: 'both' });

    expect(await seriesValue(DIVERGENCE, { field: 'place' })).toBe(1);
    expect(await seriesValue(DIVERGENCE, { field: 'prize' })).toBe(1);
    expect(await seriesValue(DIVERGENCE, { field: 'both' })).toBe(1);
  });

  it('the unresolved-conflict counter is its own series, unlabelled, and starts at a real 0', async () => {
    // Unlabelled is load-bearing: it emits 0 from process start instead of being absent until the
    // first increment, so a `> 0` rule on it cannot fail open the way one on a label-bearing
    // counter can.
    expect(await seriesValue(UNRESOLVED, {})).toBe(0);

    recordChallengeWinnerConflictUnresolved();
    expect(await seriesValue(UNRESOLVED, {})).toBe(1);

    // And it must NOT be folded into the divergence counter: that one means "the payout was
    // reconciled onto the stored row", the opposite money verdict.
    expect(await readMetric(DIVERGENCE)).toHaveLength(0);
  });

  it('both helpers stay never-throw', () => {
    expect(() =>
      recordChallengeWinnerDuplicatePick({ count: undefined, origin: 'caller' })
    ).not.toThrow();
    expect(() => recordChallengeWinnerConflictUnresolved()).not.toThrow();
  });
});

describe('never-throw guarantee', () => {
  it('a throwing counter.inc is swallowed — the record helper never throws', async () => {
    const metric = client.register.getSingleMetric(
      'civitai_app_challenge_created_total'
    ) as unknown as { inc: (...a: unknown[]) => void };
    const original = metric.inc;
    metric.inc = () => {
      throw new Error('boom — must never surface');
    };
    try {
      expect(() => recordChallengeCreated({ source: 'User', buzzType: 'yellow' })).not.toThrow();
    } finally {
      metric.inc = original;
    }
  });

  it('helpers tolerate undefined/null inputs without throwing', () => {
    expect(() =>
      recordChallengeCreated({ source: undefined, buzzType: null })
    ).not.toThrow();
    expect(() => recordChallengeScanResult({ result: undefined as unknown as string })).not.toThrow();
    expect(() => recordChallengeVoided({})).not.toThrow();
    expect(() =>
      recordChallengeRefundBuzz({ amount: undefined as unknown as number })
    ).not.toThrow();
  });
});

describe('state gauges — collect() emits series from injected (mocked) cache', () => {
  it('challenge_by_status / ingestion_pending / completing_stuck / budget_ratio', async () => {
    __setChallengeGaugeCacheForTest({
      byStatus: [
        { source: 'User', status: 'Active', count: 4 },
        { source: 'User', status: 'Scheduled', count: 2 },
        { source: 'System', status: 'Completed', count: 9 },
      ],
      ingestionPending: [{ source: 'User', count: 3 }],
      completingStuck: [{ source: 'System', count: 1 }],
      budgetRatio: [{ source: 'System', ratio: 0.25 }],
    });

    expect(
      await valueFor('civitai_app_challenge_by_status', { source: 'User', status: 'Active' })
    ).toBe(4);
    expect(
      await valueFor('civitai_app_challenge_by_status', { source: 'System', status: 'Completed' })
    ).toBe(9);
    expect(await valueFor('civitai_app_challenge_ingestion_pending', { source: 'User' })).toBe(3);
    expect(await valueFor('civitai_app_challenge_completing_stuck', { source: 'System' })).toBe(1);
    expect(
      await valueFor('civitai_app_challenge_operation_budget_used_ratio', { source: 'System' })
    ).toBe(0.25);
  });

  it('gauge collect() normalizes an unexpected source/status value from the DB', async () => {
    __setChallengeGaugeCacheForTest({
      byStatus: [{ source: 'GARBAGE', status: 'WeirdState', count: 7 }],
    });
    expect(
      await valueFor('civitai_app_challenge_by_status', { source: 'unknown', status: 'unknown' })
    ).toBe(7);
  });
});

describe('state gauges — zero-emit so a healthy 0 is distinguishable from dead instrumentation', () => {
  // NOTE: these assert on the emitted SERIES LIST, never via valueFor() — valueFor returns
  // `?? 0` for a missing series, so it cannot tell "emitted 0" from "emitted nothing", which is
  // the entire bug under test.
  const ZERO_EMIT_GAUGES = [
    'civitai_app_challenge_ingestion_pending',
    'civitai_app_challenge_completing_stuck',
    'civitai_app_challenge_operation_budget_used_ratio',
  ] as const;

  async function sourcePairs(name: string): Promise<[string, number][]> {
    const values = await readMetric(name);
    return values
      .map((v) => [v.labels.source, v.value] as [string, number])
      // Codepoint sort (NOT localeCompare — that is locale-dependent and orders 'unknown'
      // before 'User', which would make this assertion machine-dependent).
      .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  }

  it('emits an explicit 0 for every known source when the query returns no rows', async () => {
    // Exactly the production steady state: healthy system, every GROUP BY returns zero rows.
    __setChallengeGaugeCacheForTest({});

    for (const name of ZERO_EMIT_GAUGES) {
      expect(await sourcePairs(name), `${name} must emit a real 0 per source, not nothing`).toEqual([
        ['Mod', 0],
        ['System', 0],
        ['User', 0],
      ]);
    }
  });

  it('query rows overlay the zeros; sources missing from the rows still emit 0', async () => {
    __setChallengeGaugeCacheForTest({
      ingestionPending: [{ source: 'User', count: 3 }],
      completingStuck: [{ source: 'System', count: 1 }],
      budgetRatio: [{ source: 'System', ratio: 0.25 }],
    });

    expect(await sourcePairs('civitai_app_challenge_ingestion_pending')).toEqual([
      ['Mod', 0],
      ['System', 0],
      ['User', 3],
    ]);
    expect(await sourcePairs('civitai_app_challenge_completing_stuck')).toEqual([
      ['Mod', 0],
      ['System', 1],
      ['User', 0],
    ]);
    expect(await sourcePairs('civitai_app_challenge_operation_budget_used_ratio')).toEqual([
      ['Mod', 0],
      ['System', 0.25],
      ['User', 0],
    ]);
  });

  it('an out-of-enum source from the DB is added alongside the zeros, not instead of them', async () => {
    __setChallengeGaugeCacheForTest({ ingestionPending: [{ source: 'GARBAGE', count: 5 }] });

    expect(await sourcePairs('civitai_app_challenge_ingestion_pending')).toEqual([
      ['Mod', 0],
      ['System', 0],
      ['User', 0],
      ['unknown', 5],
    ]);
  });

  it('challenge_by_status stays SPARSE — no source×status zero-fill (deliberate, cardinality)', async () => {
    __setChallengeGaugeCacheForTest({
      byStatus: [{ source: 'User', status: 'Active', count: 4 }],
    });

    // 1 series, not the 15-series 3×5 cross-product. See the ZERO-EMIT comment in the module.
    expect(await readMetric('civitai_app_challenge_by_status')).toHaveLength(1);
  });

  it('gauge collect() never throws even if the injected cache holds junk', async () => {
    __setChallengeGaugeCacheForTest({
      ingestionPending: [{ source: null as unknown as string, count: NaN }],
    });
    await expect(readMetric('civitai_app_challenge_ingestion_pending')).resolves.toBeDefined();
  });
});
