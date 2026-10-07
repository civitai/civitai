import type { Prisma } from '@prisma/client';
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

/** A payout was recorded and its Buzz has not moved yet. */
export function isPayoutPending(state: {
  payoutRecordedAt: Date | null;
  payoutSettledAt: Date | null;
}) {
  return !!state.payoutRecordedAt && !state.payoutSettledAt;
}

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
