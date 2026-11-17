import type { Prisma } from '@prisma/client';

/**
 * The claimer's recorded claims in [start, end): what the monthly allowance counts. A removed claim
 * still counts, so removal cannot free allowance.
 */
export async function countGiftClaims(
  client: Pick<Prisma.TransactionClient, '$queryRaw'>,
  userId: number,
  start: Date,
  end: Date
) {
  const [{ used }] = await client.$queryRaw<{ used: number }[]>`
    SELECT count(*)::int AS used
      FROM "ModelVersionGiftRedemption"
     WHERE "userId" = ${userId}
       AND "claimedAt" >= ${start}::timestamp(3)
       AND "claimedAt" < ${end}::timestamp(3)
  `;
  return used;
}
