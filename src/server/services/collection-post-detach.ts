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
 * `Post.collectionId` is ON DELETE CASCADE and `Image.postId` is ON DELETE SET NULL, so deleting a
 * collection deletes every post created into it — including every entrant's — and leaves their
 * images alive with no post, still served by the feed's search index.
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
