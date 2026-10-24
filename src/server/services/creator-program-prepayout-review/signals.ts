import * as z from 'zod';

const positive = z.number().positive();

export const prepayoutLimitsSchema = z.object({
  counterparty: positive,
  singlePayerShare: positive.max(1),
  singlePayerAmount: positive,
  payoutJump: positive,
  batchPayer: positive,
  youngPayerDays: positive,
  /** Only payouts at or above this percentile of the batch can count as a jump. */
  payoutJumpPercentile: positive.max(1),
  /** How many earlier payouts the jump compares against. */
  historyPeriods: z.number().int().min(1).max(12),
});
export type PrepayoutLimits = z.infer<typeof prepayoutLimitsSchema>;

export function parseLimits(raw: string | null | undefined): PrepayoutLimits | null {
  if (!raw) return null;
  try {
    const parsed = prepayoutLimitsSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export const PREPAYOUT_SIGNALS = [
  'counterparty',
  'restricted',
  'warned-again',
  'single-payer',
  'payout-jump',
  'batch-payer',
  'withheld-carried',
] as const;
export type PrepayoutSignal = (typeof PREPAYOUT_SIGNALS)[number];

export const SIGNAL_LABELS: Record<PrepayoutSignal, string> = {
  counterparty: 'two-way Buzz with one account',
  restricted: 'muted or under a pending restriction',
  'warned-again': 'already warned about two-way Buzz, exchanging again',
  'single-payer': 'one payer funded most of the earnings',
  'payout-jump': 'payout far above their usual',
  'batch-payer': 'funded by other creators in the same payout',
  'withheld-carried': 'withheld last cycle and up for a new decision',
};

export type Counterparty = { userId: number; received: number; sent: number };

export type CreatorMetrics = {
  userId: number;
  payoutCents: number;
  /** Bankable Buzz the creator received in the period, from users and the system. */
  bankable: number;
  /** Every user who paid the creator bankable Buzz in the period, with what the creator sent back. */
  counterparties: Counterparty[];
  /** The creator's payouts in the previous batches, most recent first. */
  priorPayoutsCents: number[];
  account: { muted: boolean; pendingRestriction: boolean };
  /** Set when the counterparty review has already warned this creator. */
  warnedAt: string | null;
};

export type BatchContext = {
  limits: PrepayoutLimits;
  /** The counterparty review's minimum (#6181), or null while unset. */
  counterpartyMinimum: number | null;
  payoutCutoffCents: number;
  batchCreatorIds: ReadonlySet<number>;
};

export type SignalDetail = { value: number; limit: number; counterpartyId?: number };

const twoWay = (c: Counterparty) => Math.min(c.received, c.sent);

export function median(values: number[]) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

export function payoutCutoffCents(payoutsCents: number[], percentile: number) {
  if (!payoutsCents.length) return Infinity;
  const sorted = [...payoutsCents].sort((a, b) => a - b);
  return sorted[Math.floor(percentile * (sorted.length - 1))];
}

export function evaluateCreator(metrics: CreatorMetrics, ctx: BatchContext) {
  const { limits } = ctx;
  const fired = new Map<PrepayoutSignal, SignalDetail>();

  const topExchange = [...metrics.counterparties].sort((a, b) => twoWay(b) - twoWay(a))[0];
  const maxTwoWay = topExchange ? twoWay(topExchange) : 0;
  if (maxTwoWay >= limits.counterparty)
    fired.set('counterparty', {
      value: maxTwoWay,
      limit: limits.counterparty,
      counterpartyId: topExchange.userId,
    });

  if (metrics.account.muted || metrics.account.pendingRestriction)
    fired.set('restricted', { value: 1, limit: 1 });

  if (metrics.warnedAt && ctx.counterpartyMinimum !== null && maxTwoWay >= ctx.counterpartyMinimum)
    fired.set('warned-again', {
      value: maxTwoWay,
      limit: ctx.counterpartyMinimum,
      counterpartyId: topExchange.userId,
    });

  const topPayer = [...metrics.counterparties].sort((a, b) => b.received - a.received)[0];
  if (topPayer && metrics.bankable > 0) {
    const share = topPayer.received / metrics.bankable;
    if (share >= limits.singlePayerShare && topPayer.received >= limits.singlePayerAmount)
      fired.set('single-payer', {
        value: topPayer.received,
        limit: limits.singlePayerAmount,
        counterpartyId: topPayer.userId,
      });
  }

  const usual = median(metrics.priorPayoutsCents);
  if (usual && metrics.payoutCents >= ctx.payoutCutoffCents) {
    const ratio = metrics.payoutCents / usual;
    if (ratio >= limits.payoutJump)
      fired.set('payout-jump', { value: ratio, limit: limits.payoutJump });
  }

  const fromBatch = metrics.counterparties
    .filter((c) => c.userId !== metrics.userId && ctx.batchCreatorIds.has(c.userId))
    .reduce((sum, c) => sum + c.received, 0);
  if (fromBatch >= limits.batchPayer)
    fired.set('batch-payer', { value: fromBatch, limit: limits.batchPayer });

  return fired;
}
