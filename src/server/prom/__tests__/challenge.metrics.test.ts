import { describe, it, expect, beforeEach } from 'vitest';
import client from 'prom-client';
import {
  normSource,
  normVoidReason,
  recordChallengeWinnerDuplicatePick,
  recordChallengeWinnerConflictUnresolved,
  recordChallengeCreated,
  recordChallengeScanResult,
  recordChallengeVoided,
  recordChallengeEntryFeesBuzz,
  recordChallengePrizePaidBuzz,
  recordChallengeRefundBuzz,
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

  it('normVoidReason bounds to moderator|nsfw|activation, free-text → other', () => {
    expect(normVoidReason('moderator')).toBe('moderator');
    expect(normVoidReason('nsfw')).toBe('nsfw');
    expect(normVoidReason('activation')).toBe('activation');
    expect(normVoidReason('because-i-said-so')).toBe('other');
    expect(normVoidReason(undefined)).toBe('other');
  });
});

describe('economy counters — inc by buzz amount, skip non-positive', () => {
  it('non-positive / non-finite amounts are ignored (no series, no NaN)', async () => {
    recordChallengeEntryFeesBuzz({ source: 'User', buzzType: 'yellow', amount: 0 });
    recordChallengeEntryFeesBuzz({ source: 'User', buzzType: 'yellow', amount: -10 });
    recordChallengePrizePaidBuzz({ source: 'User', buzzType: 'yellow', amount: NaN });

    expect(await readMetric('civitai_app_challenge_entry_fees_buzz_total')).toHaveLength(0);
    expect(await readMetric('civitai_app_challenge_prize_paid_buzz_total')).toHaveLength(0);
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
    expect(() => recordChallengeCreated({ source: undefined, buzzType: null })).not.toThrow();
    expect(() =>
      recordChallengeScanResult({ result: undefined as unknown as string })
    ).not.toThrow();
    expect(() => recordChallengeVoided({})).not.toThrow();
    expect(() =>
      recordChallengeRefundBuzz({ amount: undefined as unknown as number })
    ).not.toThrow();
  });
});

describe('state gauges — collect() emits series from injected (mocked) cache', () => {
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
    return (
      values
        .map((v) => [v.labels.source, v.value] as [string, number])
        // Codepoint sort (NOT localeCompare — that is locale-dependent and orders 'unknown'
        // before 'User', which would make this assertion machine-dependent).
        .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    );
  }

  it('emits an explicit 0 for every known source when the query returns no rows', async () => {
    // Exactly the production steady state: healthy system, every GROUP BY returns zero rows.
    __setChallengeGaugeCacheForTest({});

    for (const name of ZERO_EMIT_GAUGES) {
      expect(await sourcePairs(name), `${name} must emit a real 0 per source, not nothing`).toEqual(
        [
          ['Mod', 0],
          ['System', 0],
          ['User', 0],
        ]
      );
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
