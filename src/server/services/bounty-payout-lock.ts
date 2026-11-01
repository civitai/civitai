import { Prisma } from '@prisma/client';
import type { Availability } from '~/shared/utils/prisma/enums';

export type BountyPayoutState = {
  userId: number | null;
  complete: boolean;
  refunded: boolean;
  poi: boolean;
  availability: Availability;
  meta: Prisma.JsonValue | null;
  payoutRecordedAt: Date | null;
  payoutSettledAt: Date | null;
  payoutWinnerUserId: number | null;
};

/** A payout was recorded and has not settled since: a later award records again over a settled one. */
export function isPayoutPending(state: {
  payoutRecordedAt: Date | null;
  payoutSettledAt: Date | null;
}) {
  return (
    !!state.payoutRecordedAt &&
    (!state.payoutSettledAt || state.payoutSettledAt < state.payoutRecordedAt)
  );
}

/** How long a payout stays pending before the retry job takes it over. */
export const BOUNTY_PAYOUT_RETRY_AFTER_MS = 10 * 60 * 1000;

/**
 * A pending payout the retry job has taken over, read from the same `payoutRecordedAt` it selects
 * on. Such a bounty takes no new support or awards.
 */
export function isPayoutOverdue(
  state: { payoutRecordedAt: Date | null; payoutSettledAt: Date | null },
  now = Date.now()
) {
  return (
    isPayoutPending(state) &&
    (state.payoutRecordedAt?.getTime() ?? 0) <= now - BOUNTY_PAYOUT_RETRY_AFTER_MS
  );
}

/**
 * The `payoutRecordedAt` (and an award's `awardedAt`) for a claim made under the lock: later than
 * the last settlement and the last record even when clocks disagree, so the claim reads as pending
 * and a settlement covers exactly the awards dated at or before it.
 */
export function nextPayoutRecordedAt(locked: {
  payoutSettledAt: Date | null;
  payoutRecordedAt: Date | null;
}) {
  return new Date(
    Math.max(
      Date.now(),
      (locked.payoutSettledAt?.getTime() ?? 0) + 1,
      (locked.payoutRecordedAt?.getTime() ?? 0) + 1
    )
  );
}

/** `nextPayoutRecordedAt` in SQL, on the alias `b`. */
export const NEXT_PAYOUT_RECORDED_AT_SQL = `GREATEST(NOW(), b."payoutSettledAt" + interval '1 millisecond', b."payoutRecordedAt" + interval '1 millisecond')`;

/** `isPayoutPending` as a query, on the alias `b`. */
export const payoutPendingSql = Prisma.sql`(b."payoutRecordedAt" IS NOT NULL
  AND (b."payoutSettledAt" IS NULL OR b."payoutSettledAt" < b."payoutRecordedAt"))`;

// Every path that moves Buzz for a bounty takes this row lock first, checks the state it
// returns, and records its claim (`payoutRecordedAt`) in the same transaction. The Buzz calls run
// after commit, through `settleBountyPayout`.
export async function lockBountyForPayout(
  tx: Prisma.TransactionClient,
  bountyId: number
): Promise<BountyPayoutState | null> {
  const [row] = await tx.$queryRaw<BountyPayoutState[]>`
    SELECT
      "userId",
      complete,
      refunded,
      poi,
      availability,
      meta,
      "payoutRecordedAt",
      "payoutSettledAt",
      "payoutWinnerUserId"
    FROM "Bounty"
    WHERE id = ${bountyId}
    FOR UPDATE
  `;
  return row ?? null;
}
