import type { Prisma } from '@prisma/client';

/**
 * Claims of the creator's gift links in [start, end): what the monthly limit counts. A claim the
 * creator or a moderator removed does not count.
 */
export async function countCreatorGiftClaims(
  client: Pick<Prisma.TransactionClient, '$queryRaw'>,
  creatorId: number,
  start: Date,
  end: Date
) {
  const [{ used }] = await client.$queryRaw<{ used: number }[]>`
    SELECT count(*)::int AS used
      FROM "ModelVersionGiftRedemption" r
      JOIN "ModelVersionGiftLink" l ON l.id = r."giftLinkId"
     WHERE l."createdById" = ${creatorId}
       AND r."claimedAt" >= ${start}::timestamp(3)
       AND r."claimedAt" < ${end}::timestamp(3)
       AND r."revokedAt" IS NULL
  `;
  return used;
}
