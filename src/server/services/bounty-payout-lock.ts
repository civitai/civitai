import type { Prisma } from '@prisma/client';
import type { Availability } from '~/shared/utils/prisma/enums';

export type BountyPayoutState = {
  userId: number | null;
  complete: boolean;
  refunded: boolean;
  poi: boolean;
  availability: Availability;
  meta: Prisma.JsonValue | null;
};

// Every path that moves Buzz for a bounty takes this row lock first, checks the state it
// returns, and writes its claim in the same transaction. The Buzz calls run after commit.
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
      meta
    FROM "Bounty"
    WHERE id = ${bountyId}
    FOR UPDATE
  `;
  return row ?? null;
}
