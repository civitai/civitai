import type { Prisma, PrismaClient } from '@prisma/client';
import type { PayoutReviewFlag, RunOutcome } from './run';

type Db = Pick<PrismaClient, 'creatorProgramPayoutReview' | 'creatorProgramPayoutReviewRun'>;

export function createPayoutReviewStore(db: Db) {
  const saveFlag = async (
    { period, userId, signals, payoutCents, evidence }: PayoutReviewFlag,
    attempt = 0
  ): Promise<{ created: boolean; reopened: boolean }> => {
    const key = { period_userId: { period, userId } };
    const json = evidence as Prisma.InputJsonValue;
    const existing = await db.creatorProgramPayoutReview.findUnique({
      where: key,
      select: { status: true, signals: true },
    });
    if (!existing) {
      await db.creatorProgramPayoutReview.create({
        data: { period, userId, signals, payoutCents, evidence: json },
      });
      return { created: true, reopened: false };
    }

    const seen = new Set(existing.signals);
    const reopened = existing.status === 'cleared' && signals.some((s) => !seen.has(s));
    // Conditional on the status read above: a decision landing in between must not be overwritten,
    // nor a new signal recorded as seen by a clear that never saw it.
    const { count } = await db.creatorProgramPayoutReview.updateMany({
      where: { period, userId, status: existing.status },
      data: {
        signals: [...new Set([...existing.signals, ...signals])],
        payoutCents,
        evidence: json,
        lastEvaluatedAt: new Date(),
        evaluations: { increment: 1 },
        ...(reopened && {
          status: 'open',
          hold: true,
          decidedAt: null,
          decidedBy: null,
          decisionNote: null,
        }),
      },
    });
    if (!count) {
      if (attempt >= 2) throw new Error(`Review ${period}/${userId} kept changing while saving`);
      return saveFlag({ period, userId, signals, payoutCents, evidence }, attempt + 1);
    }
    return { created: false, reopened };
  };

  return {
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
