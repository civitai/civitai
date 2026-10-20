import { MAX_REASON_LENGTH, type AbuseReportInput } from '@civitai/moderation';
import dayjs from '~/shared/utils/dayjs';
import {
  loadBatch,
  loadEarnings,
  loadPriorPayouts,
  periodWindow,
  type ReviewClickhouse,
} from './detect';
import {
  evaluateCreator,
  SIGNAL_LABELS,
  payoutCutoffCents,
  type Counterparty,
  type PrepayoutLimits,
  type PrepayoutSignal,
  type SignalDetail,
} from './signals';

export const PREPAYOUT_REVIEW_DETECTOR = 'creator-program-prepayout';

export type AccountState = {
  username: string | null;
  createdAt: Date;
  muted: boolean;
  pendingRestriction: boolean;
  banned: boolean;
  programBanned: boolean;
};

export type PayoutReviewFlag = {
  period: string;
  userId: number;
  signals: PrepayoutSignal[];
  payoutCents: number;
  evidence: Record<string, unknown>;
};

export type RunOutcome = {
  creditedCount: number;
  evaluatedCount: number;
  flaggedCount: number;
  error: string | null;
};

export type PrepayoutReviewDeps = {
  ch: ReviewClickhouse | null;
  readLimits: () => Promise<PrepayoutLimits | null>;
  readCounterpartyMinimum: () => Promise<number | null>;
  getWarnedAt: (userIds: number[]) => Promise<Map<number, string>>;
  loadAccounts: (userIds: number[]) => Promise<Map<number, AccountState>>;
  /** Creators whose latest review before `period` was withheld: each comes up for a new decision. */
  getCarriedUserIds: (period: string) => Promise<number[]>;
  store: {
    startRun: (period: string, startedAt: Date) => Promise<number>;
    finishRun: (runId: number, outcome: RunOutcome & { finishedAt: Date }) => Promise<void>;
    saveFlag: (flag: PayoutReviewFlag) => Promise<{ created: boolean; reopened: boolean }>;
  };
  sendReport: (report: AbuseReportInput) => Promise<unknown>;
  now: () => Date;
  log?: (name: string, data: Record<string, unknown>) => void;
};

export const reviewPeriod = (now: Date) => dayjs.utc(now).subtract(1, 'month').format('YYYY-MM');

const twoWay = (c: Counterparty) => Math.min(c.received, c.sent);
const dollars = (cents: number) => `$${(cents / 100).toFixed(2)}`;

function buildEvidence(
  metrics: { payoutCents: number; bankable: number; priorPayoutsCents: number[] },
  counterparties: Counterparty[],
  fired: Map<PrepayoutSignal, SignalDetail>,
  ctx: {
    accounts: Map<number, AccountState>;
    account: AccountState | undefined;
    warnedAt: string | null;
    batchCreatorIds: ReadonlySet<number>;
    youngSince: Date;
  }
) {
  const person = (userId: number) => {
    const a = ctx.accounts.get(userId);
    return { userId, username: a?.username ?? null, createdAt: a?.createdAt ?? null };
  };
  const young = counterparties
    .filter((c) => {
      const createdAt = ctx.accounts.get(c.userId)?.createdAt;
      return createdAt && createdAt >= ctx.youngSince;
    })
    .reduce((sum, c) => sum + c.received, 0);

  return {
    payoutCents: metrics.payoutCents,
    bankable: metrics.bankable,
    priorPayoutsCents: metrics.priorPayoutsCents,
    account: { ...ctx.account, warnedAt: ctx.warnedAt },
    signals: Object.fromEntries(fired),
    exchanges: counterparties
      .filter((c) => c.sent > 0)
      .sort((a, b) => twoWay(b) - twoWay(a))
      .slice(0, 10)
      .map((c) => ({ ...person(c.userId), received: c.received, sent: c.sent })),
    topPayers: [...counterparties]
      .sort((a, b) => b.received - a.received)
      .slice(0, 5)
      .map((c) => ({
        ...person(c.userId),
        received: c.received,
        share: metrics.bankable ? c.received / metrics.bankable : null,
        inBatch: ctx.batchCreatorIds.has(c.userId),
      })),
    youngPayerShare: metrics.bankable ? young / metrics.bankable : null,
  };
}

export async function runPrepayoutReview(deps: PrepayoutReviewDeps): Promise<RunOutcome> {
  const startedAt = deps.now();
  const period = reviewPeriod(startedAt);
  // From the 15th the batch has settled; a hold filed then would block the next payout over cash
  // already paid.
  if (startedAt.getUTCDate() > 14) {
    deps.log?.('creator-program-prepayout-review-skipped', { period, reason: 'after the 14th' });
    return { creditedCount: 0, evaluatedCount: 0, flaggedCount: 0, error: 'after the 14th' };
  }
  const runId = await deps.store.startRun(period, startedAt);
  const outcome: RunOutcome = { creditedCount: 0, evaluatedCount: 0, flaggedCount: 0, error: null };
  const finish = async () => {
    await deps.store.finishRun(runId, { ...outcome, finishedAt: deps.now() });
    deps.log?.(
      outcome.error
        ? 'creator-program-prepayout-review-failed'
        : 'creator-program-prepayout-review-finished',
      { period, ...outcome }
    );
    return outcome;
  };

  try {
    const limits = await deps.readLimits();
    if (!limits) {
      outcome.error = 'limits not set';
      return await finish();
    }
    if (!deps.ch) {
      outcome.error = 'clickhouse unavailable';
      return await finish();
    }

    const credited = await loadBatch(deps.ch, period);
    outcome.creditedCount = credited.length;
    if (!credited.length) {
      outcome.error = 'no pending payouts found for the period';
      return await finish();
    }

    const carried = new Set(await deps.getCarriedUserIds(period));
    const batch = [
      ...credited,
      ...[...carried]
        .filter((userId) => !credited.some((c) => c.userId === userId))
        .map((userId) => ({ userId, payoutCents: 0 })),
    ];
    const userIds = batch.map((b) => b.userId);
    const [prior, earnings, counterpartyMinimum, warnedAt] = await Promise.all([
      loadPriorPayouts(deps.ch, userIds, period, limits.historyPeriods),
      loadEarnings(deps.ch, userIds, period),
      deps.readCounterpartyMinimum(),
      deps.getWarnedAt(userIds),
    ]);
    const payerIds = [...earnings.counterparties.values()].flat().map((c) => c.userId);
    const accounts = await deps.loadAccounts([...new Set([...userIds, ...payerIds])]);

    const ctx = {
      limits,
      counterpartyMinimum,
      payoutCutoffCents: payoutCutoffCents(
        credited.map((b) => b.payoutCents),
        limits.payoutJumpPercentile
      ),
      batchCreatorIds: new Set(userIds),
    };
    const youngSince = dayjs
      .utc(periodWindow(period).start)
      .subtract(limits.youngPayerDays, 'day')
      .toDate();

    const findings: AbuseReportInput['findings'] = [];
    for (const { userId, payoutCents } of batch) {
      const account = accounts.get(userId);
      const counterparties = earnings.counterparties.get(userId) ?? [];
      const metrics = {
        userId,
        payoutCents,
        bankable: earnings.bankable.get(userId) ?? 0,
        counterparties,
        priorPayoutsCents: prior.get(userId) ?? [],
        account: {
          muted: account?.muted ?? false,
          pendingRestriction: account?.pendingRestriction ?? false,
        },
        warnedAt: warnedAt.get(userId) ?? null,
      };
      outcome.evaluatedCount++;

      const fired = evaluateCreator(metrics, ctx);
      if (carried.has(userId)) fired.set('withheld-carried', { value: 1, limit: 1 });
      if (!fired.size) continue;
      outcome.flaggedCount++;

      const signals = [...fired.keys()];
      const { created, reopened } = await deps.store.saveFlag({
        period,
        userId,
        signals,
        payoutCents,
        evidence: buildEvidence(metrics, counterparties, fired, {
          accounts,
          account,
          warnedAt: metrics.warnedAt,
          batchCreatorIds: ctx.batchCreatorIds,
          youngSince,
        }),
      });
      if (created || reopened)
        findings.push({
          userId,
          confidence: 0.9,
          reason: `${
            reopened ? 'Held again, after new signals since it was cleared,' : 'Held'
          } the ${period} Creator Program payout (${dollars(payoutCents)}) for review: ${signals
            .map((s) => SIGNAL_LABELS[s])
            .join('; ')}.`.slice(0, MAX_REASON_LENGTH),
          actioned: true,
          action: 'held',
        });
    }

    await finish();

    // The review table is the record; a failed board report must not fail the run.
    await deps
      .sendReport({
        detector: PREPAYOUT_REVIEW_DETECTOR,
        startedAt: startedAt.toISOString(),
        finishedAt: deps.now().toISOString(),
        summary: `Reviewed ${outcome.evaluatedCount} of ${outcome.creditedCount} creators in the ${period} payout; ${outcome.flaggedCount} held, ${findings.length} newly.`,
        counters: {
          credited: outcome.creditedCount,
          evaluated: outcome.evaluatedCount,
          held: outcome.flaggedCount,
          newlyHeld: findings.length,
        },
        findings,
      })
      .catch((e: Error) =>
        deps.log?.('creator-program-prepayout-review-report-failed', { error: e.message })
      );
    return outcome;
  } catch (e) {
    outcome.error = (e as Error).message;
    await finish();
    throw e;
  }
}
