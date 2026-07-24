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
