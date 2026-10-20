import { describe, expect, it } from 'vitest';
import {
  evaluateCreator,
  parseLimits,
  payoutCutoffCents,
  type BatchContext,
  type CreatorMetrics,
  type PrepayoutLimits,
} from '../signals';

// Synthetic values for these tests only. Production limits are not committed.
const limits: PrepayoutLimits = {
  counterparty: 1_000,
  singlePayerShare: 0.6,
  singlePayerAmount: 500,
  payoutJump: 4,
  batchPayer: 700,
  youngPayerDays: 10,
  payoutJumpPercentile: 0.75,
  historyPeriods: 5,
};

const ctx = (over: Partial<BatchContext> = {}): BatchContext => ({
  limits,
  counterpartyMinimum: 400,
  payoutCutoffCents: 10_000,
  batchCreatorIds: new Set([1, 50]),
  ...over,
});

// Ten payers of 100 each, nothing sent back, a steady payout history: no signal fires.
const clean = (over: Partial<CreatorMetrics> = {}): CreatorMetrics => ({
  userId: 1,
  payoutCents: 2_000,
  bankable: 1_000,
  counterparties: Array.from({ length: 10 }, (_, i) => ({
    userId: 100 + i,
    received: 100,
    sent: 0,
  })),
  priorPayoutsCents: [2_000, 1_800, 2_200],
  account: { muted: false, pendingRestriction: false },
  warnedAt: null,
  ...over,
});

const fired = (metrics: CreatorMetrics, context = ctx()) => [
  ...evaluateCreator(metrics, context).keys(),
];

describe('evaluateCreator', () => {
  it('fires nothing for a creator with many small payers and a steady history', () => {
    expect(fired(clean())).toEqual([]);
  });

  it.each([
    [999, []],
    [1_000, ['counterparty']],
  ])('counterparty: two-way %i', (twoWay, expected) => {
    const metrics = clean({
      counterparties: [{ userId: 7, received: twoWay, sent: twoWay + 5 }],
      bankable: 100_000,
    });
    expect(fired(metrics)).toEqual(expected);
  });

  it('counterparty measures the smaller direction, so a one-way payer never fires', () => {
    const metrics = clean({
      counterparties: [{ userId: 7, received: 40_000, sent: 999 }],
      bankable: 1_000_000,
    });
    expect(fired(metrics)).toEqual([]);
  });

  it.each([
    [{ muted: true, pendingRestriction: false }, ['restricted']],
    [{ muted: false, pendingRestriction: true }, ['restricted']],
  ])('restricted: %j', (account, expected) => {
    expect(fired(clean({ account }))).toEqual(expected);
  });

  it.each([
    [null, 400, []],
    ['2026-11-03T00:00:00.000Z', 399, []],
    ['2026-11-03T00:00:00.000Z', 400, ['warned-again']],
  ])('warned-again: warnedAt %s, two-way %i', (warnedAt, twoWay, expected) => {
    const metrics = clean({
      warnedAt,
      counterparties: [{ userId: 7, received: twoWay, sent: twoWay }],
      bankable: 100_000,
    });
    expect(fired(metrics)).toEqual(expected);
  });

  it('warned-again stays off while the counterparty minimum is unset', () => {
    const metrics = clean({
      warnedAt: '2026-11-03T00:00:00.000Z',
      counterparties: [{ userId: 7, received: 900, sent: 900 }],
      bankable: 100_000,
    });
    expect(fired(metrics, ctx({ counterpartyMinimum: null }))).toEqual([]);
  });

  it.each([
    [500, 834, []], // share 0.5995
    [499, 800, []], // share 0.62, amount under
    [500, 833, ['single-payer']], // share 0.6002, amount at the limit
  ])('single-payer: %i of %i', (received, bankable, expected) => {
    const metrics = clean({ bankable, counterparties: [{ userId: 9, received, sent: 0 }] });
    expect(fired(metrics)).toEqual(expected);
  });

  it.each([
    [7_999, 7_000, []], // ratio under 4
    [8_000, 8_000, ['payout-jump']],
    [8_000, 8_001, []], // below the batch cutoff
  ])('payout-jump: %i cents, batch cutoff %i', (payoutCents, batchCutoff, expected) => {
    const metrics = clean({ payoutCents, priorPayoutsCents: [2_000, 1_000, 3_000] });
    expect(fired(metrics, ctx({ payoutCutoffCents: batchCutoff }))).toEqual(expected);
  });

  it('payout-jump needs a history: a first payout never fires it', () => {
    expect(fired(clean({ payoutCents: 1_000_000, priorPayoutsCents: [] }))).toEqual([]);
  });

  it.each([
    [699, []],
    [700, ['batch-payer']],
  ])('batch-payer: %i from another creator in the batch', (received, expected) => {
    const metrics = clean({
      bankable: 100_000,
      counterparties: [
        { userId: 50, received, sent: 0 },
        { userId: 60, received: 5_000, sent: 0 },
      ],
    });
    expect(fired(metrics)).toEqual(expected);
  });
});

describe('evaluateCreator boundaries and detail', () => {
  it('single-payer fires at exactly the share limit', () => {
    const metrics = clean({
      bankable: 1_000,
      counterparties: [{ userId: 9, received: 600, sent: 0 }],
    });
    expect(fired(metrics)).toEqual(['single-payer']);
  });

  it('payout-jump compares against the median of an even history', () => {
    // Median of [1_000, 3_000] is 2_000, so 8_000 is exactly 4x.
    const metrics = clean({ payoutCents: 8_000, priorPayoutsCents: [1_000, 3_000] });
    expect(fired(metrics, ctx({ payoutCutoffCents: 8_000 }))).toEqual(['payout-jump']);
  });

  it('batch-payer adds up every payer from the batch', () => {
    const metrics = clean({
      bankable: 100_000,
      counterparties: [
        { userId: 50, received: 400, sent: 0 },
        { userId: 51, received: 400, sent: 0 },
      ],
    });
    expect(fired(metrics, ctx({ batchCreatorIds: new Set([1, 50, 51]) }))).toEqual(['batch-payer']);
  });

  it('names the largest exchange and the largest payer when there are several', () => {
    const metrics = clean({
      bankable: 2_000,
      counterparties: [
        { userId: 7, received: 1_100, sent: 1_000 },
        { userId: 8, received: 1_500, sent: 1_200 },
        { userId: 9, received: 300, sent: 0 },
      ],
    });
    const detail = evaluateCreator(metrics, ctx({ limits: { ...limits, singlePayerShare: 0.7 } }));
    expect(detail.get('counterparty')).toEqual({ value: 1_200, limit: 1_000, counterpartyId: 8 });
    expect(detail.get('single-payer')).toEqual({ value: 1_500, limit: 500, counterpartyId: 8 });
  });
});

describe('payoutCutoffCents', () => {
  it.each([
    [[1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11], 0.75, 8],
    [[10, 20, 30, 40, 50, 60, 70, 80, 90, 100], 0.75, 70],
    [[10, 20, 30, 40, 50, 60, 70, 80, 90, 100], 0.5, 50],
  ])('is the payout at the configured percentile position of %j (%s)', (payouts, pct, expected) => {
    expect(payoutCutoffCents(payouts, pct)).toBe(expected);
  });

  it('lets nothing through for an empty batch', () => {
    expect(payoutCutoffCents([], 0.75)).toBe(Infinity);
  });
});

describe('parseLimits', () => {
  it.each([null, '', 'nope', '{}', JSON.stringify({ ...limits, singlePayerShare: 1.5 })])(
    'rejects %j',
    (raw) => {
      expect(parseLimits(raw)).toBeNull();
    }
  );

  it('accepts a complete set', () => {
    expect(parseLimits(JSON.stringify(limits))).toEqual(limits);
  });
});
