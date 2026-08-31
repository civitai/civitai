import type { Prisma } from '@prisma/client';

/**
 * `Post.collectionId` is ON DELETE CASCADE and `Image.postId` is ON DELETE SET NULL, so deleting a
 * collection deletes every post created into it — including other people's — and leaves their
 * images alive with no post. The images then 404 on their own detail page while still serving from
 * the feed's search index.
 *
 * Detaching first keeps those posts as ordinary posts on their owner's profile. Callers must run
 * this in the same transaction as the delete, or a failure in between leaves posts pointing at a
 * collection that still exists.
 */
export async function detachPostsFromCollection(
  tx: Prisma.TransactionClient,
  collectionId: number
) {
  return tx.$executeRaw`
    UPDATE "Post" SET "collectionId" = NULL WHERE "collectionId" = ${collectionId}
  `;
}

/**
 * Account deletion drops every collection the user owns, so the same cascade fires — and a contest
 * or challenge collection holds posts belonging to the people who entered it, not to the departing
 * user. Their own posts are deleted by id straight after this and are unaffected by the detach.
 */
export async function detachPostsFromUserCollections(tx: Prisma.TransactionClient, userId: number) {
  return tx.$executeRaw`
    UPDATE "Post" SET "collectionId" = NULL
    WHERE "collectionId" IN (SELECT id FROM "Collection" WHERE "userId" = ${userId})
  `;
}
