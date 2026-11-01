import type { Prisma } from '@prisma/client';

/**
 * Marks the chapters that removed placements added as removed. Called inside the moderator
 * takedown's own transaction (`takeDownApproved`), so it imports nothing from the placement layer
 * and touches Postgres only through `tx`.
 *
 * Idempotent: a chapter already marked keeps its first `removedAt`, and a placement that never
 * became a chapter (pending, declined, expired) matches nothing. Returns how many were marked.
 */
export async function tombstoneChaptersForPlacements(
  { placementIds }: { placementIds: number[] },
  tx: Prisma.TransactionClient
) {
  if (!placementIds.length) return 0;
  const { count } = await tx.storylineChapter.updateMany({
    where: { placementId: { in: placementIds }, removedAt: null },
    data: { removedAt: new Date() },
  });
  return count;
}
