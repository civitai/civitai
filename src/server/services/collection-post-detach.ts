import { dbWrite } from '~/server/db/client';

const DETACH_BATCH_SIZE = 1000;

// A run past ~1M posts means the loop isn't draining. Throw rather than spin: a runaway await
// loop starves the macrotask queue, so vitest's setTimeout-based testTimeout never fires.
const MAX_DETACH_BATCHES = 1000;

/**
 * `Post_collectionId_fkey` is ON DELETE SET NULL, so correctness no longer depends on this — the
 * database spares entrant posts on every path, including the ones no service owns. What survives is
 * the cost of letting the FK do it: measured against the largest contest collection (22,833 posts),
 * its SET NULL runs 23.0s inside the DELETE, holding row locks on every one of those posts for the
 * duration.
 *
 * So the callers that run in a user request drain the collection first, in batches that release
 * between each. In `deleteChallenge` that is also load-bearing for a different reason — it must run
 * OUTSIDE the delete transaction, since 23.0s is past Prisma's 5s interactive default.
 *
 * A partial detach is safe to retry: those posts have merely left a collection that still exists.
 */
export async function detachPostsFromCollection(collectionId: number) {
  let total = 0;
  for (let batch = 0; batch < MAX_DETACH_BATCHES; batch++) {
    const detached = await dbWrite.$executeRaw`
      UPDATE "Post" SET "collectionId" = NULL
      WHERE id IN (
        SELECT id FROM "Post" WHERE "collectionId" = ${collectionId} LIMIT ${DETACH_BATCH_SIZE}
      )
    `;
    total += detached;
    if (detached < DETACH_BATCH_SIZE) return total;
  }
  throw new Error(`detachPostsFromCollection exceeded ${MAX_DETACH_BATCHES} batches`);
}
