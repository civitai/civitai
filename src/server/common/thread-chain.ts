import { Prisma } from '@prisma/client';

export const UNRESOLVED_THREAD_CHAIN_MESSAGE = 'comment thread is no longer available';

/**
 * Every owner-bearing FK on `Thread`. A thread with none of them and no parent comment is an
 * ORPHAN — its parent comment was deleted, and `Thread.commentId` is `onDelete: SetNull`, so the
 * link upward is gone while its replies remain. A column missing from this list turns that
 * entity's threads into apparent orphans and refuses writes on them, so it must stay complete.
 * `threadContentSelect` in `block-check.service.ts` lists the same owners, minus `clubPostId`, which
 * has no owner lookup.
 */
export const threadIsRooted = (alias: string) => Prisma.sql`num_nonnulls(
  ${Prisma.raw(alias)}."questionId", ${Prisma.raw(alias)}."answerId", ${Prisma.raw(
  alias
)}."imageId",
  ${Prisma.raw(alias)}."postId", ${Prisma.raw(alias)}."reviewId", ${Prisma.raw(alias)}."modelId",
  ${Prisma.raw(alias)}."articleId", ${Prisma.raw(alias)}."bountyId",
  ${Prisma.raw(alias)}."bountyEntryId", ${Prisma.raw(alias)}."clubPostId",
  ${Prisma.raw(alias)}."comicProjectId", ${Prisma.raw(alias)}."challengeId",
  ${Prisma.raw(alias)}."model3dId", ${Prisma.raw(alias)}."model3dReviewId",
  ${Prisma.raw(alias)}."appListingId", ${Prisma.raw(alias)}."crucibleId"
) > 0`;

/**
 * Both a cycle backstop and a ceiling on how deep the old thread-chain walkers (the lock check, the
 * block guard, the block hide sweep) climb. `throwIfThreadChainLocked` treats the cap as "could not
 * resolve" and REFUSES the write: a walk that ran out of road has not proved the absence of a lock.
 * Real chains run past it (measurements: docs/comments-consolidation.md, Thread mute), so it bounds
 * the work; it is not a proof.
 */
export const MAX_THREAD_CHAIN_DEPTH = 100;

/**
 * The ancestor walk up the old thread chain, for the block guard. Climbs `Thread.commentId ->
 * CommentV2.threadId` ONLY, the edge `throwIfThreadChainLocked` uses, never `Thread.parentThreadId`,
 * which older rows took from client input on the first reply.
 *
 * `UNION ALL` because the depth cap, not a dedupe, bounds it: `depth` is projected, so no row is a
 * duplicate while the CTE is seeded with ONE row. Seed it with many and siblings converge on shared
 * ancestors, at which point `UNION` is worth revisiting.
 *
 * Out-degree is 1 because BOTH joins in the recursive term are primary-key equalities (`th.id` and
 * `pc.id`), so each row yields at most one successor. That does not depend on any constraint anyone
 * could drop.
 */
export const threadAncestorsCte = (seedExpression: string) => `WITH RECURSIVE thread_ancestors AS (
              SELECT ${seedExpression} "id", 0 "depth"
              UNION ALL
              SELECT pc."threadId", mt."depth" + 1
              FROM thread_ancestors mt
              JOIN "Thread" th ON th.id = mt."id"
              JOIN "CommentV2" pc ON pc.id = th."commentId"
              WHERE mt."depth" < ${MAX_THREAD_CHAIN_DEPTH}
            )`;

/**
 * `threadAncestorsCte` for many seeds at once: the same edge and cap, with each row carrying the
 * seed it climbed from. `seedSelect` must project `"seedId"` and `"threadId"`. `UNION ALL` stays
 * right here because rows from different seeds differ in `"seedId"`, so none is a duplicate.
 */
export const seededThreadChainCte = (seedSelect: string) => `WITH RECURSIVE seeded_chain AS (
              SELECT s."seedId", s."threadId" "id", 0 "depth" FROM (${seedSelect}) s
              UNION ALL
              SELECT sc."seedId", pc."threadId", sc."depth" + 1
              FROM seeded_chain sc
              JOIN "Thread" th ON th.id = sc."id"
              JOIN "CommentV2" pc ON pc.id = th."commentId"
              WHERE sc."depth" < ${MAX_THREAD_CHAIN_DEPTH}
            )`;
