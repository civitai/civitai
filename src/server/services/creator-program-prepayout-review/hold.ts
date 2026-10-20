import { Prisma } from '@prisma/client';
import { TRPCError } from '@trpc/server';
import * as z from 'zod';
import { OnboardingSteps } from '~/server/common/enums';
import { dbWrite } from '~/server/db/client';
import { logToAxiom } from '~/server/logging/client';
import { Flags } from '~/shared/utils/flags';

/** Statuses under which a held row keeps the creator out of settlement. */
const HOLDING_STATUSES = ['open', 'escalated', 'withheld'];

const isMissingTable = (e: unknown) =>
  e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2021';

/**
 * Who settlement must skip, who it must add, and whether the review finished a clean run over the
 * period.
 *
 * Cleared creators are added because settlement otherwise pays only last month's participants: a
 * creator cleared after the 15th would never be paid if they did not bank again. Banned creators
 * are left out, as `getPoolParticipantsV2` leaves them out.
 *
 * Tables that do not exist yet (deployed before the migration) hold nobody and count as not
 * reviewed, so the batch still pays and settlement alerts.
 */
export async function getSettlementHolds(period: string) {
  try {
    const [rows, run] = await Promise.all([
      dbWrite.creatorProgramPayoutReview.findMany({
        where: { status: { in: [...HOLDING_STATUSES, 'cleared'] } },
        select: { userId: true, status: true, hold: true },
      }),
      dbWrite.creatorProgramPayoutReviewRun.findFirst({
        where: { period, finishedAt: { not: null }, error: null },
        select: { id: true },
      }),
    ]);
    const heldUserIds = new Set(
      rows.filter((r) => r.hold && HOLDING_STATUSES.includes(r.status)).map((r) => r.userId)
    );
    const clearedIds = [
      ...new Set(rows.filter((r) => r.status === 'cleared').map((r) => r.userId)),
    ].filter((id) => !heldUserIds.has(id));
    const payable = clearedIds.length
      ? await dbWrite.user.findMany({
          where: { id: { in: clearedIds }, bannedAt: null },
          select: { id: true, onboarding: true },
        })
      : [];
    const clearedUserIds = payable
      .filter((u) => !Flags.hasFlag(u.onboarding, OnboardingSteps.BannedCreatorProgram))
      .map((u) => u.id);

    return { heldUserIds, clearedUserIds, reviewed: !!run, tablesExist: true };
  } catch (e) {
    if (!isMissingTable(e)) throw e;
    return {
      heldUserIds: new Set<number>(),
      clearedUserIds: [] as number[],
      reviewed: false,
      tablesExist: false,
    };
  }
}

export function splitHeldBalances<T extends { accountId: number; balance: number }>(
  balances: T[],
  heldUserIds: ReadonlySet<number>
) {
  const positive = balances.filter((b) => b.balance > 0);
  return {
    settle: positive.filter((b) => !heldUserIds.has(b.accountId)),
    held: positive.filter((b) => heldUserIds.has(b.accountId)),
  };
}

export const payoutReviewDecisionSchema = z.object({
  id: z.number().int().positive(),
  action: z.enum(['escalate', 'clear', 'withhold']),
  /** The row's `evaluations` when the decider read its evidence. */
  evaluations: z.number().int().positive(),
  decidedBy: z.string().min(1),
  note: z.string().optional(),
  askRef: z.string().optional(),
});
export type PayoutReviewDecision = z.infer<typeof payoutReviewDecisionSchema>;

const TRANSITIONS: Record<PayoutReviewDecision['action'], string[]> = {
  escalate: ['open'],
  // From `withheld` too, so a withhold made in error can be undone.
  clear: ['open', 'escalated', 'withheld'],
  withhold: ['open', 'escalated'],
};

const conflict = (message: string) => new TRPCError({ code: 'CONFLICT', message });

/** A cleared creator is paid by the next settlement run on the 15th; nothing here moves money. */
export async function decidePayoutReview(input: PayoutReviewDecision, now = new Date()) {
  const review = await dbWrite.creatorProgramPayoutReview.findUnique({ where: { id: input.id } });
  if (!review) throw new TRPCError({ code: 'NOT_FOUND', message: `No review ${input.id}` });

  if (review.evaluations !== input.evaluations)
    throw conflict(
      `Review ${review.id} has newer evidence (evaluation ${review.evaluations}); read it again`
    );
  if (!TRANSITIONS[input.action].includes(review.status))
    throw conflict(`Cannot ${input.action} a review that is ${review.status}`);

  const status = { escalate: 'escalated', clear: 'cleared', withhold: 'withheld' }[input.action];
  // Conditional on what was read, so neither a racing decision nor a re-run adding evidence the
  // decider never saw can slip in between.
  const { count } = await dbWrite.creatorProgramPayoutReview.updateMany({
    where: { id: review.id, status: review.status, evaluations: input.evaluations },
    data: {
      status,
      hold: input.action !== 'clear',
      decidedAt: now,
      decidedBy: input.decidedBy,
      decisionNote: input.note,
      askRef: input.askRef ?? review.askRef,
    },
  });
  if (!count) throw conflict(`Review ${review.id} changed while deciding it`);

  await logToAxiom({
    name: 'creator-program-payout-review-decision',
    type: 'info',
    reviewId: review.id,
    userId: review.userId,
    period: review.period,
    action: input.action,
    decidedBy: input.decidedBy,
    askRef: input.askRef,
  });
  return { id: review.id, status };
}
