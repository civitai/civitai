import { Prisma, type PrismaClient } from '@prisma/client';
import { decisionHistory, type PayoutReviewDecisionEntry } from './hold';
import type { PayoutReviewFlag, RunOutcome } from './run';

type Db = Pick<PrismaClient, 'creatorProgramPayoutReview' | 'creatorProgramPayoutReviewRun'>;

export function createPayoutReviewStore(db: Db) {
  const saveFlag = async (
    { period, userId, signals, payoutCents, evidence }: PayoutReviewFlag,
    attempt = 0
  ): Promise<{ created: boolean; reopened: boolean }> => {
    const retry = () => saveFlag({ period, userId, signals, payoutCents, evidence }, attempt + 1);
    const json = evidence as Prisma.InputJsonValue;
    const existing = await db.creatorProgramPayoutReview.findUnique({
      where: { period_userId: { period, userId } },
      select: { status: true, signals: true, version: true, decisions: true },
    });
    if (!existing) {
      try {
        await db.creatorProgramPayoutReview.create({
          data: { period, userId, signals, payoutCents, evidence: json },
        });
        return { created: true, reopened: false };
      } catch (e) {
        // An overlapping run filed it first; update that row instead.
        const duplicate = e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002';
        if (!duplicate || attempt >= 2) throw e;
        return retry();
      }
    }

    const seen = new Set(existing.signals);
    const fresh = signals.filter((s) => !seen.has(s));
    const reopened = existing.status === 'cleared' && fresh.length > 0;
    const reopen: PayoutReviewDecisionEntry = {
      at: new Date().toISOString(),
      by: 'prepayout-review',
      action: 'reopened',
      from: existing.status,
      to: 'open',
      version: existing.version,
      note: `New signals: ${fresh.join(', ')}`,
      askRef: null,
    };
    // Conditional on the version read: a decision landing in between must not be overwritten,
    // nor a new signal recorded as seen by a clear that never saw it.
    const { count } = await db.creatorProgramPayoutReview.updateMany({
      where: { period, userId, version: existing.version },
      data: {
        signals: [...new Set([...existing.signals, ...signals])],
        payoutCents,
        evidence: json,
        lastEvaluatedAt: new Date(),
        evaluations: { increment: 1 },
        version: { increment: 1 },
        ...(reopened && {
          status: 'open',
          hold: true,
          decisions: [...decisionHistory(existing.decisions), reopen] as Prisma.InputJsonValue,
        }),
      },
    });
    if (!count) {
      if (attempt >= 2) throw new Error(`Review ${period}/${userId} kept changing while saving`);
      return retry();
    }
    return { created: false, reopened };
  };

  return {
    getCarriedUserIds: async (period: string) => {
      const latest = await db.creatorProgramPayoutReview.findMany({
        where: { period: { lt: period } },
        orderBy: [{ userId: 'asc' }, { period: 'desc' }],
        distinct: ['userId'],
        select: { userId: true, status: true },
      });
      return latest.filter((r) => r.status === 'withheld').map((r) => r.userId);
    },

    startRun: async (period: string, startedAt: Date) =>
      (await db.creatorProgramPayoutReviewRun.create({ data: { period, startedAt } })).id,

    finishRun: async (runId: number, data: RunOutcome & { finishedAt: Date }) => {
      await db.creatorProgramPayoutReviewRun.update({ where: { id: runId }, data });
    },

    /**
     * A re-run refreshes the evidence and leaves the decision alone, except that a signal not seen
     * when a creator was cleared reopens the hold.
     */
    saveFlag: (flag: PayoutReviewFlag) => saveFlag(flag),
  };
}
