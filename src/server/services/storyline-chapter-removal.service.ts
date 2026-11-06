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
  // Every chapter of these placements, not only the ones marked now, so a retry finishes the job.
  const chapters = await tx.storylineChapter.findMany({
    where: { placementId: { in: placementIds } },
    select: { id: true },
  });
  await clearTombstoneTips(
    chapters.map((c) => c.id),
    tx
  );
  return count;
}

/**
 * Keeps the main route from ending at a tombstone: nothing can continue a removed chapter, so a
 * route ending at one leaves the owner no end to add to. Starting at `chapterIds`, each removed
 * chapter with no canon child loses its canon edges, and its parents are tried in turn, so a leaf
 * removed under an earlier tombstone moves the end past both. A removed chapter that still has a
 * canon child keeps its edge: the route stays followable past it to the live chapters after it.
 *
 * Call it in the removal's transaction, after the removal: with the chapter itself for a
 * tombstone, with its parents for a hard delete. Chapters that are live or not tips are no-ops.
 */
export async function clearTombstoneTips(chapterIds: number[], tx: Prisma.TransactionClient) {
  let frontier = chapterIds;
  // One round per tombstone up the chain; the cap only guards against a cycle.
  for (let round = 0; frontier.length && round < 10_000; round++) {
    const cleared = await tx.$queryRaw<{ parentChapterId: number }[]>`
      UPDATE "StorylineChapterEdge" e SET canon = false
      FROM "StorylineChapter" c
      WHERE c.id = e."chapterId" AND e."chapterId" = ANY(${frontier}::int[]) AND e.canon
        AND c."removedAt" IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM "StorylineChapterEdge" k WHERE k."parentChapterId" = c.id AND k.canon
        )
      RETURNING e."parentChapterId"
    `;
    frontier = [...new Set(cleared.map((r) => r.parentChapterId))];
  }
}
