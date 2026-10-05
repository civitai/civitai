import { Prisma } from '@prisma/client';
import { dbWrite } from '~/server/db/client';

// The invite gate reads the owner's tier off the hub session, which ranks comped tiers from
// UserMembershipOverride alongside real subscriptions. Reading subscriptions alone would let a
// comped owner invite successfully and then be switched off overnight.
export const collaborationMemberUserIds = Prisma.sql`
  SELECT cs."userId"
  FROM "CustomerSubscription" cs
  WHERE cs.status IN ('active', 'trialing')
    AND cs."currentPeriodEnd" >= NOW()
  UNION
  SELECT o."userId"
  FROM "UserMembershipOverride" o
  WHERE o.tier <> 'free'
`;

// Only reopens. Closing is left to the nightly reconcile so a cancellation webhook can't shut a
// collection while its paid period is still running.
export async function reopenLapsedCollections(userId: number) {
  await dbWrite.$executeRaw(Prisma.sql`
    UPDATE "Collection" c
    SET "collaborationDisabledAt" = NULL
    WHERE c."userId" = ${userId}
      AND c."collaborationDisabledAt" IS NOT NULL
      AND EXISTS (
        SELECT 1 FROM (${collaborationMemberUserIds}) m WHERE m."userId" = ${userId}
      )
  `);
}
