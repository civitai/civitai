import { dbWrite } from '~/server/db/client';

const DETACH_BATCH_SIZE = 1000;

// A run past ~1M posts means the loop isn't draining. Throw rather than spin: a runaway await
// loop starves the macrotask queue, so vitest's setTimeout-based testTimeout never fires.
const MAX_DETACH_BATCHES = 1000;

async function detachInBatches(nextBatch: () => Promise<number>) {
  let total = 0;
  for (let batch = 0; batch < MAX_DETACH_BATCHES; batch++) {
    const detached = await nextBatch();
    total += detached;
    if (detached < DETACH_BATCH_SIZE) return total;
  }
  throw new Error(`detachPostsFromCollection exceeded ${MAX_DETACH_BATCHES} batches`);
}

/**
 * Kept after the `Post_collectionId_fkey` -> SET NULL migration, not superseded by it. Migrations
 * here are applied by hand per environment, so this is what protects an environment the migration
 * has not reached yet; and by emptying the collection first it leaves the DELETE with no rows to
 * re-parent, instead of the FK doing all ~23k in one statement inside the delete.
 *
 * Must run OUTSIDE the deleting transaction: the largest collection takes ~25s, past Prisma's 5s
 * interactive default. A partial detach is safe to retry — those posts have merely left a
 * collection that still exists.
 */
export async function detachPostsFromCollection(collectionId: number) {
  return detachInBatches(
    () => dbWrite.$executeRaw`
      UPDATE "Post" SET "collectionId" = NULL
      WHERE id IN (
        SELECT id FROM "Post" WHERE "collectionId" = ${collectionId} LIMIT ${DETACH_BATCH_SIZE}
      )
    `
  );
}

/**
 * Account deletion drops every collection the user owns, firing the same cascade — a contest
 * collection holds the entrants' posts, not the departing user's.
 */
export async function detachPostsFromUserCollections(userId: number) {
  return detachInBatches(
    () => dbWrite.$executeRaw`
      UPDATE "Post" SET "collectionId" = NULL
      WHERE id IN (
        SELECT p.id FROM "Post" p
        JOIN "Collection" c ON c.id = p."collectionId"
        WHERE c."userId" = ${userId}
        LIMIT ${DETACH_BATCH_SIZE}
      )
    `
  );
}
