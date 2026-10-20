import type { Prisma, PrismaClient } from '@prisma/client';
import type { PayoutReviewFlag, RunOutcome } from './run';

type Db = Pick<PrismaClient, 'creatorProgramPayoutReview' | 'creatorProgramPayoutReviewRun'>;

export function createPayoutReviewStore(db: Db) {
  return {
    startRun: async (period: string, startedAt: Date) =>
      (await db.creatorProgramPayoutReviewRun.create({ data: { period, startedAt } })).id,

    finishRun: async (runId: number, data: RunOutcome & { finishedAt: Date }) => {
      await db.creatorProgramPayoutReviewRun.update({ where: { id: runId }, data });
    },

    /**
     * A re-run refreshes the evidence and leaves the decision alone, except that a signal not seen
     * when a creator was cleared reopens the hold, unless the payout was already released.
     */
    saveFlag: async ({ period, userId, signals, payoutCents, evidence }: PayoutReviewFlag) => {
      const key = { period_userId: { period, userId } };
      const json = evidence as Prisma.InputJsonValue;
      const existing = await db.creatorProgramPayoutReview.findUnique({
        where: key,
        select: { status: true, signals: true, releasedAt: true },
      });
      if (!existing) {
        await db.creatorProgramPayoutReview.create({
          data: { period, userId, signals, payoutCents, evidence: json },
        });
        return { created: true, reopened: false };
      }

      const seen = new Set(existing.signals);
      const reopened =
        existing.status === 'cleared' && !existing.releasedAt && signals.some((s) => !seen.has(s));
      await db.creatorProgramPayoutReview.update({
        where: key,
        data: {
          signals: [...new Set([...existing.signals, ...signals])],
          payoutCents,
          evidence: json,
          lastEvaluatedAt: new Date(),
          evaluations: { increment: 1 },
          ...(reopened && { status: 'open', hold: true }),
        },
      });
      return { created: false, reopened };
    },
  };
}
