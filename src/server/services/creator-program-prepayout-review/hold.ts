import { Prisma } from '@prisma/client';
import { TRPCError } from '@trpc/server';
import * as z from 'zod';
import { NotificationCategory, OnboardingSteps } from '~/server/common/enums';
import { dbWrite } from '~/server/db/client';
import { logToAxiom } from '~/server/logging/client';
import { createNotification } from '~/server/services/notification.service';
import { reviewPeriod } from './run';
import { Flags } from '~/shared/utils/flags';
import { BuzzWithdrawalRequestStatus, CashWithdrawalStatus } from '~/shared/utils/prisma/enums';

const HOLDING_STATUSES = ['open', 'escalated', 'withheld'];

const isMissingTable = (e: unknown) =>
  e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2021';

type HoldRow = { userId: number; status: string; hold: boolean; period: string };
const holdRowQuery = (userId?: number) => ({
  where: {
    status: { in: [...HOLDING_STATUSES, 'cleared'] },
    ...(userId !== undefined ? { userId } : {}),
  },
  select: { userId: true, status: true, hold: true, period: true },
});

/**
 * An undecided review holds in any period. A withhold applies to its own cycle and stands until a
 * later period's review decides the creator again, so only the latest one counts.
 */
function resolveHolds(rows: HoldRow[]) {
  const latest = new Map<number, HoldRow>();
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
  return { latest, heldUserIds };
}

/** The same hold settlement applies, read for one user at cash-out. */
export async function hasPayoutHold(userId: number) {
  try {
    const rows = await dbWrite.creatorProgramPayoutReview.findMany(holdRowQuery(userId));
    return resolveHolds(rows).heldUserIds.has(userId);
  } catch (e) {
    if (!isMissingTable(e)) throw e;
    await logToAxiom({
      name: 'creator-program-payout-hold-unchecked',
      type: 'error',
      userId,
      message: 'Payout review table missing; cash-out refused',
    }).catch(() => undefined);
    // Fail closed: a hold that cannot be read must not let money out.
    throw new TRPCError({
      code: 'INTERNAL_SERVER_ERROR',
      message: 'Cash-out is temporarily unavailable. Please try again later.',
    });
  }
}

export async function assertNoPayoutHold(userId: number) {
  if (await hasPayoutHold(userId))
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'Your cash-out is on hold pending review. Please contact support for details.',
    });
}

/**
 * Cleared creators are added because settlement otherwise pays only last month's participants, so
 * one cleared after the 15th would never be paid. Banned creators are left out, as
 * `getPoolParticipantsV2` leaves them out.
 */
export async function getSettlementHolds(period: string) {
  try {
    const [rows, run] = await Promise.all([
      dbWrite.creatorProgramPayoutReview.findMany(holdRowQuery()),
      dbWrite.creatorProgramPayoutReviewRun.findFirst({
        where: { period, finishedAt: { not: null }, error: null },
        select: { id: true },
      }),
    ]);
    const { latest, heldUserIds } = resolveHolds(rows);
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
  action: PayoutReviewDecision['action'] | 'reopened' | 'opened';
  ground?: PayoutHoldGround;
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

export const payoutHoldGrounds = [
  'investigation',
  'developer-terms-breach',
  'fraud',
  'chargeback',
  'terms-of-service-breach',
  'acceptance-pending',
] as const;
export type PayoutHoldGround = (typeof payoutHoldGrounds)[number];

export const openPayoutHoldSchema = z.object({
  userId: z.number().int().positive(),
  ground: z.enum(payoutHoldGrounds),
  reason: z.string().trim().min(1),
  askRef: z.string().optional(),
});
export type OpenPayoutHold = z.infer<typeof openPayoutHoldSchema>;

/**
 * Opens a review for a creator the detector did not flag, in the current period. Released like any
 * other review, through `decidePayoutReview`. `openedBy` is the authenticated caller.
 */
export async function openPayoutHold(input: OpenPayoutHold, openedBy: string, now = new Date()) {
  const user = await dbWrite.user.findUnique({ where: { id: input.userId }, select: { id: true } });
  if (!user) throw new TRPCError({ code: 'NOT_FOUND', message: `No user ${input.userId}` });
  if (await hasPayoutHold(input.userId))
    throw conflict(`User ${input.userId} already has a payout hold`);

  // The detector's period, so a manual hold and a detector flag for one cycle share a row and a
  // cleared manual hold is never newer than a withhold from the same cycle.
  const period = reviewPeriod(now);
  const existing = await dbWrite.creatorProgramPayoutReview.findUnique({
    where: { period_userId: { period, userId: input.userId } },
  });
  const entry: PayoutReviewDecisionEntry = {
    at: now.toISOString(),
    by: openedBy,
    action: 'opened',
    ground: input.ground,
    from: existing?.status ?? 'none',
    to: 'open',
    version: existing?.version ?? 0,
    note: input.reason,
    askRef: input.askRef ?? null,
  };
  const signal = `manual:${input.ground}`;

  let review: { id: number; version: number };
  if (!existing) {
    try {
      review = await dbWrite.creatorProgramPayoutReview.create({
        data: {
          period,
          userId: input.userId,
          signals: [signal],
          payoutCents: 0,
          evidence: { manual: { ground: input.ground, reason: input.reason } },
          askRef: input.askRef ?? null,
          decisions: [entry] as Prisma.InputJsonValue,
        },
        select: { id: true, version: true },
      });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002')
        throw conflict(`A review for user ${input.userId} in ${period} was filed meanwhile; retry`);
      throw e;
    }
  } else {
    // An unheld open/escalated row, or a withhold a later cleared period superseded: deciding it
    // belongs to the review it already is.
    if (existing.status !== 'cleared')
      throw conflict(
        `Review ${existing.id} for ${period} is ${existing.status}; decide it in payout review instead`
      );
    const { count } = await dbWrite.creatorProgramPayoutReview.updateMany({
      where: { id: existing.id, version: existing.version, status: 'cleared' },
      data: {
        status: 'open',
        hold: true,
        signals: [...new Set([...existing.signals, signal])],
        askRef: input.askRef ?? existing.askRef,
        version: { increment: 1 },
        decisions: [...decisionHistory(existing.decisions), entry] as Prisma.InputJsonValue,
      },
    });
    if (!count) throw conflict(`Review ${existing.id} changed while opening a hold; retry`);
    review = { id: existing.id, version: existing.version + 1 };
  }

  await logToAxiom({
    name: 'creator-program-payout-review-decision',
    type: 'info',
    reviewId: review.id,
    userId: input.userId,
    period,
    ...entry,
  });
  await createNotification({
    userId: input.userId,
    type: 'creators-program-cash-out-on-hold',
    category: NotificationCategory.System,
    key: `creators-program-cash-out-on-hold:${review.id}:${review.version}`,
    details: {},
  }).catch(() => undefined);

  const [cashWithdrawals, buzzWithdrawalRequests] = await Promise.all([
    dbWrite.cashWithdrawal.findMany({
      where: { userId: input.userId, status: { notIn: SETTLED_CASH_STATUSES } },
      select: { id: true, status: true, amount: true, createdAt: true },
    }),
    dbWrite.buzzWithdrawalRequest.findMany({
      where: { userId: input.userId, status: BuzzWithdrawalRequestStatus.Requested },
      select: { id: true, status: true, requestedBuzzAmount: true, createdAt: true },
    }),
  ]);

  // Withdrawals requested before the hold are not stopped by it; the caller decides each one.
  return {
    id: review.id,
    period,
    status: 'open',
    version: review.version,
    inFlight: { cashWithdrawals, buzzWithdrawalRequests },
  };
}

const SETTLED_CASH_STATUSES = [
  CashWithdrawalStatus.Paid,
  CashWithdrawalStatus.Rejected,
  CashWithdrawalStatus.Canceled,
  CashWithdrawalStatus.FailedFee,
  CashWithdrawalStatus.Reclaimed,
];
