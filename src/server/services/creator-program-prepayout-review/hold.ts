import { Prisma } from '@prisma/client';
import { TRPCError } from '@trpc/server';
import * as z from 'zod';
import { OnboardingSteps } from '~/server/common/enums';
import { dbWrite } from '~/server/db/client';
import { logToAxiom } from '~/server/logging/client';
import { Flags } from '~/shared/utils/flags';

const HOLDING_STATUSES = ['open', 'escalated', 'withheld'];

const isMissingTable = (e: unknown) =>
  e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2021';

/**
 * Cleared creators are added because settlement otherwise pays only last month's participants, so
 * one cleared after the 15th would never be paid. Banned creators are left out, as
 * `getPoolParticipantsV2` leaves them out.
 */
export async function getSettlementHolds(period: string) {
  try {
    const [rows, run] = await Promise.all([
      dbWrite.creatorProgramPayoutReview.findMany({
        where: { status: { in: [...HOLDING_STATUSES, 'cleared'] } },
        select: { userId: true, status: true, hold: true, period: true },
      }),
      dbWrite.creatorProgramPayoutReviewRun.findFirst({
        where: { period, finishedAt: { not: null }, error: null },
        select: { id: true },
      }),
    ]);
    // An undecided review holds in any period. A withhold applies to its own cycle and stands
    // until a later period's review decides the creator again, so only the latest one counts.
    const latest = new Map<number, (typeof rows)[number]>();
    for (const r of rows) {
      const seen = latest.get(r.userId);
      if (!seen || r.period > seen.period) latest.set(r.userId, r);
    }
    const heldUserIds = new Set([
      ...rows
        .filter((r) => r.hold && (r.status === 'open' || r.status === 'escalated'))
        .map((r) => r.userId),
      ...[...latest.values()].filter((r) => r.status === 'withheld').map((r) => r.userId),
    ]);
    const clearedIds = [...latest.values()]
      .filter((r) => r.status === 'cleared' && !heldUserIds.has(r.userId))
      .map((r) => r.userId);
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
  userId: z.number().int().positive(),
  period: z.string().regex(/^\d{4}-\d{2}$/),
  action: z.enum(['escalate', 'clear', 'withhold']),
  /** The row's `version` when the decider read it; every write to the row bumps it. */
  version: z.number().int().positive(),
  note: z.string().optional(),
  askRef: z.string().optional(),
});
export type PayoutReviewDecision = z.infer<typeof payoutReviewDecisionSchema>;

export type PayoutReviewDecisionEntry = {
  at: string;
  by: string;
  action: PayoutReviewDecision['action'] | 'reopened';
  from: string;
  to: string;
  version: number;
  note: string | null;
  askRef: string | null;
};

const TRANSITIONS: Record<PayoutReviewDecision['action'], string[]> = {
  // escalate and withhold also accept cleared, so a mistaken clear can be reversed before
  // settlement pays it.
  escalate: ['open', 'cleared'],
  withhold: ['open', 'escalated', 'cleared'],
  clear: ['open', 'escalated', 'withheld'],
};

const conflict = (message: string) => new TRPCError({ code: 'CONFLICT', message });

export const decisionHistory = (value: Prisma.JsonValue) =>
  (Array.isArray(value) ? value : []) as unknown as PayoutReviewDecisionEntry[];

/** `decidedBy` is the authenticated caller, never a value from the request. */
export async function decidePayoutReview(
  input: PayoutReviewDecision,
  decidedBy: string,
  now = new Date()
) {
  const review = await dbWrite.creatorProgramPayoutReview.findUnique({ where: { id: input.id } });
  if (!review || review.userId !== input.userId || review.period !== input.period)
    throw new TRPCError({
      code: 'NOT_FOUND',
      message: `No review ${input.id} for user ${input.userId} in ${input.period}`,
    });

  if (review.version !== input.version)
    throw conflict(`Review ${review.id} changed since version ${input.version}; read it again`);
  if (!TRANSITIONS[input.action].includes(review.status))
    throw conflict(`Cannot ${input.action} a review that is ${review.status}`);

  const status = { escalate: 'escalated', clear: 'cleared', withhold: 'withheld' }[input.action];
  const entry: PayoutReviewDecisionEntry = {
    at: now.toISOString(),
    by: decidedBy,
    action: input.action,
    from: review.status,
    to: status,
    version: review.version,
    note: input.note ?? null,
    askRef: input.askRef ?? null,
  };
  const { count } = await dbWrite.creatorProgramPayoutReview.updateMany({
    where: { id: review.id, userId: input.userId, period: input.period, version: input.version },
    data: {
      status,
      hold: input.action !== 'clear',
      decidedAt: now,
      decidedBy,
      decisionNote: input.note ?? null,
      askRef: input.askRef ?? review.askRef,
      version: { increment: 1 },
      decisions: [...decisionHistory(review.decisions), entry] as Prisma.InputJsonValue,
    },
  });
  if (!count) throw conflict(`Review ${review.id} changed while deciding it`);

  await logToAxiom({
    name: 'creator-program-payout-review-decision',
    type: 'info',
    reviewId: review.id,
    ...entry,
  });
  return { id: review.id, status, version: review.version + 1 };
}
