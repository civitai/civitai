import { Prisma } from '@prisma/client';
import { accountHoldSql } from '~/server/services/legal-hold.service';
import { MAX_THREAD_CHAIN_DEPTH } from '~/server/common/thread-chain';

/** The `Thread` columns whose parent row, when deleted, deletes the thread and every comment in it. */
export type ThreadParentColumn =
  | 'modelId'
  | 'postId'
  | 'imageId'
  | 'articleId'
  | 'bountyId'
  | 'bountyEntryId'
  | 'questionId'
  | 'answerId'
  | 'reviewId';

/** For each column, a query selecting the ids of the parent rows about to be deleted. */
export type ThreadParents = Partial<Record<ThreadParentColumn, Prisma.Sql>>;

/**
 * `WITH RECURSIVE tree`: the threads `seeds` selects and every thread below them, along every edge a
 * delete cascades along (`parentThreadId`, `rootThreadId`) and the reply edge (`commentId`). Each
 * edge is joined from the thread alone: joined per comment, a root with C comments and R replies
 * walks C × R rows.
 */
const threadTreeSql = (seeds: Prisma.Sql) => Prisma.sql`WITH RECURSIVE tree AS (
    ${seeds}
    UNION
    SELECT n.id
    FROM tree
    CROSS JOIN LATERAL (
      SELECT c.id FROM "Thread" c WHERE c."parentThreadId" = tree.id OR c."rootThreadId" = tree.id
      UNION ALL
      SELECT c.id
      FROM "CommentV2" k
      JOIN "Thread" c ON c."commentId" = k.id
      WHERE k."threadId" = tree.id
    ) n
  )`;

/**
 * Whether a held author wrote a comment anywhere in the thread `rootId` (an int SQL expression) or
 * below it, so the unheld replies between a held one and the root are kept with it.
 */
export function heldCommentInTreeSql(rootId: Prisma.Sql, markerView: boolean): Prisma.Sql {
  return Prisma.sql`EXISTS (
    ${threadTreeSql(Prisma.sql`SELECT (${rootId})::int AS id`)}
    SELECT 1
    FROM (SELECT DISTINCT hc."userId" FROM tree JOIN "CommentV2" hc ON hc."threadId" = tree.id) a
    WHERE ${accountHoldSql(Prisma.raw('a."userId"'), markerView)}
  )`;
}

/** Not an image the hold marker's delete trigger keeps: it stays, blocked, and its threads with it. */
const notKeptByTriggerSql = (markerView: boolean) =>
  markerView
    ? Prisma.sql`AND NOT EXISTS (
        SELECT 1 FROM "Image" ki JOIN "EvidenceHeldUser" kh ON kh."userId" = ki."userId"
        WHERE ki.id = t."imageId"
      )`
    : Prisma.empty;

/**
 * CTE entries, for a `WITH` list ahead of a parent DELETE, that take every thread of those parents
 * holding a held author's comment off its parent, so the DELETE no longer cascades into it. They run
 * in the DELETE's own statement, so they detach exactly what it deletes. A detached thread keeps
 * where it came from in `metadata.detachedFrom`, for moderators, and is unreachable from the site.
 * Its comments leave the CommentV3 mirror, which the site reads, with the parent: each topic cascades
 * from its entity row. The CommentV2 rows stay.
 */
export function detachHeldThreadsCte(parents: ThreadParents, markerView: boolean): Prisma.Sql {
  const entries = Object.entries(parents).map(([column, ids], i) => {
    const col = Prisma.raw(`"${column}"`);
    return Prisma.sql`${Prisma.raw(`detached_${i}`)} AS (
      UPDATE "Thread" t
      SET ${col} = NULL,
          metadata = COALESCE(t.metadata, '{}'::jsonb) || jsonb_build_object(
            'detachedFrom', jsonb_build_object(${column}::text, t.${col}),
            'detachedAt', now()
          )
      WHERE t.${col} IN (${ids}) AND ${heldCommentInTreeSql(Prisma.raw('t.id'), markerView)}
        ${column === 'imageId' ? notKeptByTriggerSql(markerView) : Prisma.empty}
      RETURNING t.id
    )`;
  });
  return Prisma.join(entries, ', ');
}

/**
 * The detach of `detachHeldThreadsCte` as a statement of its own, for an ORM delete run right after
 * it in the same transaction.
 */
export function detachHeldThreadsSql(parents: ThreadParents, markerView: boolean): Prisma.Sql {
  return Prisma.sql`WITH ${detachHeldThreadsCte(parents, markerView)} SELECT NULL`;
}

/** The threads that cascade with a model: its own, and its reviews'. */
export const modelThreadParents = (doomed: Prisma.Sql): ThreadParents => ({
  modelId: doomed,
  reviewId: Prisma.sql`SELECT r.id FROM "ResourceReview" r WHERE r."modelId" IN (${doomed})`,
});

/** The threads that cascade with a bounty: its own, and its entries'. */
export const bountyThreadParents = (doomed: Prisma.Sql): ThreadParents => ({
  bountyId: doomed,
  bountyEntryId: Prisma.sql`SELECT e.id FROM "BountyEntry" e WHERE e."bountyId" IN (${doomed})`,
});

/** The threads that cascade with a question: its own, and its answers'. */
export const questionThreadParents = (doomed: Prisma.Sql): ThreadParents => ({
  questionId: doomed,
  answerId: Prisma.sql`SELECT a.id FROM "Answer" a WHERE a."questionId" IN (${doomed})`,
});

/**
 * Whether a held author replied anywhere below the legacy comment `commentId` (an int SQL
 * expression). A legacy reply goes with its parent: the foreign key cascades.
 */
export function heldLegacyReplyBelowSql(commentId: Prisma.Sql, markerView: boolean): Prisma.Sql {
  return Prisma.sql`EXISTS (
    WITH RECURSIVE below AS (
      SELECT r.id, r."userId" FROM "Comment" r WHERE r."parentId" = ${commentId}
      UNION
      SELECT r.id, r."userId" FROM "Comment" r JOIN below b ON r."parentId" = b.id
    ),
    authors AS MATERIALIZED (SELECT DISTINCT "userId" FROM below)
    SELECT 1 FROM authors a WHERE ${accountHoldSql(Prisma.sql`a."userId"`, markerView)}
  )`;
}

/**
 * Whether a held author wrote a legacy comment on the model `modelId` (an int SQL expression). The
 * legacy table cascades from the model and has no thread to detach, so such a model is not deleted.
 */
export function heldLegacyCommentOnModelSql(modelId: Prisma.Sql, markerView: boolean): Prisma.Sql {
  return Prisma.sql`EXISTS (
    SELECT 1 FROM "Comment" lc
    WHERE lc."modelId" = ${modelId} AND ${accountHoldSql(Prisma.raw('lc."userId"'), markerView)}
  )`;
}

/**
 * Whether the thread `seed` selects is in a detached tree: it or any thread above it, along the edges
 * the detach walks down (the reply edge, `rootThreadId`, `parentThreadId`), was detached from a
 * deleted parent.
 */
const detachedAboveSql = (seed: string) => Prisma.sql`
  WITH RECURSIVE up AS (
    SELECT ${Prisma.raw(seed)} AS id, 0 AS depth
    UNION
    SELECT n.id, up.depth + 1
    FROM up
    JOIN "Thread" th ON th.id = up.id
    CROSS JOIN LATERAL (
      SELECT pc."threadId" AS id FROM "CommentV2" pc WHERE pc.id = th."commentId"
      UNION ALL SELECT th."rootThreadId" WHERE th."rootThreadId" IS NOT NULL
      UNION ALL SELECT th."parentThreadId" WHERE th."parentThreadId" IS NOT NULL
    ) n
    WHERE up.depth < ${Prisma.raw(String(MAX_THREAD_CHAIN_DEPTH))}
  )
  SELECT EXISTS (
    SELECT 1 FROM up JOIN "Thread" t ON t.id = up.id WHERE t.metadata -> 'detachedFrom' IS NOT NULL
  ) AS detached`;

export const threadDetachedSql = (threadId: number) => detachedAboveSql(String(Number(threadId)));

export const commentDetachedSql = (commentId: number) =>
  detachedAboveSql(`(SELECT c."threadId" FROM "CommentV2" c WHERE c.id = ${Number(commentId)})`);
