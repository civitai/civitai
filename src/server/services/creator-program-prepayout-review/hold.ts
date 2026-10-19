import { Prisma } from '@prisma/client';
import * as z from 'zod';
import { NotificationCategory, SignalMessages, SignalTopic } from '~/server/common/enums';
import { dbWrite } from '~/server/db/client';
import { logToAxiom } from '~/server/logging/client';
import { createBuzzTransactionMany, getAccountsBalances } from '~/server/services/buzz.service';
import { userCashCache } from '~/server/services/creator-program.service';
import { createNotification } from '~/server/services/notification.service';
import { TransactionType } from '~/shared/constants/buzz.constants';
import { signalClient } from '~/utils/signal-client';

/** Statuses under which a held row keeps the creator out of settlement. */
const HOLDING_STATUSES = ['open', 'escalated', 'withheld'];

/** The two ledger rows the settlement job writes, under the release's own external ids. */
function pendingToSettledTransactions({
  userId,
  amount,
  description,
  bankExternalId,
  externalId,
}: {
  userId: number;
  amount: number;
  description: string;
  bankExternalId: string;
  externalId: string;
}) {
  return [
    {
      type: TransactionType.Compensation,
      fromAccountType: 'cashPending' as const,
      fromAccountId: userId,
      toAccountType: 'cashSettled' as const,
      toAccountId: 0,
      amount,
      description,
      externalTransactionId: bankExternalId,
    },
    {
      type: TransactionType.Compensation,
      fromAccountType: 'cashSettled' as const,
      fromAccountId: 0,
      toAccountType: 'cashSettled' as const,
      toAccountId: userId,
      amount,
      description,
      externalTransactionId: externalId,
    },
  ];
}

const isMissingTable = (e: unknown) =>
  e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2021';

/**
 * Who settlement must skip, and whether the review finished a clean run over the period.
 * Tables that do not exist yet (deployed before the migration) hold nobody and count as not
 * reviewed, so the batch still pays and settlement alerts.
 */
export async function getSettlementHolds(period: string) {
  try {
    const [rows, run] = await Promise.all([
      dbWrite.creatorProgramPayoutReview.findMany({
        where: { hold: true, status: { in: HOLDING_STATUSES } },
        select: { userId: true },
      }),
      dbWrite.creatorProgramPayoutReviewRun.findFirst({
        where: { period, finishedAt: { not: null }, error: null },
        select: { id: true },
      }),
    ]);
    return { heldUserIds: new Set(rows.map((r) => r.userId)), reviewed: !!run, tablesExist: true };
  } catch (e) {
    if (!isMissingTable(e)) throw e;
    return { heldUserIds: new Set<number>(), reviewed: false, tablesExist: false };
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
  action: z.enum(['escalate', 'clear', 'withhold', 'release']),
  decidedBy: z.string().min(1),
  note: z.string().optional(),
  askRef: z.string().optional(),
});
export type PayoutReviewDecision = z.infer<typeof payoutReviewDecisionSchema>;

const TRANSITIONS: Record<Exclude<PayoutReviewDecision['action'], 'release'>, string[]> = {
  escalate: ['open'],
  clear: ['open', 'escalated'],
  withhold: ['open', 'escalated'],
};

export class PayoutReviewError extends Error {
  constructor(readonly status: 404 | 409, message: string) {
    super(message);
  }
}

const conflict = (message: string) => new PayoutReviewError(409, message);

export async function decidePayoutReview(input: PayoutReviewDecision) {
  const review = await dbWrite.creatorProgramPayoutReview.findUnique({ where: { id: input.id } });
  if (!review) throw new PayoutReviewError(404, `No review ${input.id}`);

  if (input.action === 'release') return releaseHeldPayout(review);

  if (!TRANSITIONS[input.action].includes(review.status))
    throw conflict(`Cannot ${input.action} a review that is ${review.status}`);

  const status = { escalate: 'escalated', clear: 'cleared', withhold: 'withheld' }[input.action];
  // Conditional on the status read above, so two decisions racing cannot both apply.
  const { count } = await dbWrite.creatorProgramPayoutReview.updateMany({
    where: { id: review.id, status: review.status },
    data: {
      status,
      hold: input.action !== 'clear',
      decidedAt: new Date(),
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

/**
 * Settles a cleared creator's pending cash now, for a creator cleared after the 15th whose next
 * settlement run would not include them.
 */
async function releaseHeldPayout(review: {
  id: number;
  userId: number;
  status: string;
  releasedAt: Date | null;
}) {
  if (review.status !== 'cleared') throw conflict(`Only a cleared review can be released`);
  if (review.releasedAt) throw conflict(`Review ${review.id} was already released`);

  const [balance] = await getAccountsBalances({
    accountIds: [review.userId],
    accountTypes: ['cashPending'],
  });
  const amount = balance?.balance ?? 0;
  const externalId = `settlement-release-${review.id}`;

  if (amount > 0)
    await createBuzzTransactionMany(
      pendingToSettledTransactions({
        userId: review.userId,
        amount,
        description: `Cash settlement released after review ${review.id}`,
        bankExternalId: `settlement-release-bank-${review.id}`,
        externalId,
      })
    );

  await dbWrite.creatorProgramPayoutReview.update({
    where: { id: review.id },
    data: { releasedAt: new Date(), releaseExternalId: amount > 0 ? externalId : null },
  });

  if (amount > 0) {
    await createNotification({
      type: 'creator-program-funds-settled',
      category: NotificationCategory.Creator,
      key: `creator-program-funds-settled:release-${review.id}`,
      userIds: [review.userId],
      details: {},
    });
    await userCashCache.bust(review.userId);
    await signalClient.topicSend({
      topic: SignalTopic.CreatorProgram,
      target: SignalMessages.CashInvalidator,
      data: {},
    });
  }

  await logToAxiom({
    name: 'creator-program-payout-review-released',
    type: 'info',
    reviewId: review.id,
    userId: review.userId,
    amount,
  });
  return { id: review.id, status: review.status, released: amount };
}
