import { Prisma } from '@prisma/client';
import { accountHoldSql } from '~/server/services/legal-hold.service';
import { threadAncestorsCte } from '~/server/common/thread-chain';

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
 * Whether a held author wrote a comment anywhere in the thread `rootId` (an int SQL expression) or
 * below it. Walks every edge a delete cascades along (`parentThreadId`, `rootThreadId`) and the
 * reply edge (`commentId`), so the unheld replies between a held one and the root are kept with it.
 */
export function heldCommentInTreeSql(rootId: Prisma.Sql, markerView: boolean): Prisma.Sql {
  return Prisma.sql`EXISTS (
    WITH RECURSIVE tree AS (
      SELECT (${rootId})::int AS id
      UNION
      SELECT c.id
      FROM tree
      LEFT JOIN "CommentV2" k ON k."threadId" = tree.id
      JOIN "Thread" c
        ON c."parentThreadId" = tree.id OR c."rootThreadId" = tree.id OR c."commentId" = k.id
    )
    SELECT 1 FROM tree
    JOIN "CommentV2" hc ON hc."threadId" = tree.id
    WHERE ${accountHoldSql(Prisma.raw('hc."userId"'), markerView)}
  )`;
}

/**
 * CTE entries, for a `WITH` list ahead of a parent DELETE, that take every thread of those parents
 * holding a held author's comment off its parent, so the DELETE no longer cascades into it. They run
 * in the DELETE's own statement, so they detach exactly what it deletes. A detached thread keeps
 * where it came from in `metadata.detachedFrom`, for moderators, and is unreachable from the site.
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
      RETURNING t.id
    )`;
  });
  return Prisma.join(entries, ', ');
}

/**
 * The detach of `detachHeldThreadsCte` as a statement of its own, for an ORM delete run right after
 * it in the same transaction. A hold placed between the two statements is not seen, so a raw delete
 * should use `deleteKeepingHeldThreadsSql` instead.
 */
export function detachHeldThreadsSql(parents: ThreadParents, markerView: boolean): Prisma.Sql {
  return Prisma.sql`WITH ${detachHeldThreadsCte(parents, markerView)} SELECT NULL`;
}

/**
 * `DELETE FROM table` for the rows `where` matches (over `alias`, by default `d`), with every thread of theirs that
 * holds a held author's comment detached first, in the same statement. `parents` maps the ids being
 * deleted (a query) to the threads that would cascade with them, its own and those of rows it
 * cascades to.
 */
export function deleteKeepingHeldThreadsSql({
  table,
  alias = 'd',
  where,
  parents,
  markerView,
  returning = Prisma.empty,
}: {
  table: string;
  /** Quoted when it is a table name, as `'"Image"'` for a condition written against the table. */
  alias?: string;
  where: Prisma.Sql;
  parents: (doomed: Prisma.Sql) => ThreadParents;
  markerView: boolean;
  returning?: Prisma.Sql;
}): Prisma.Sql {
  const name = Prisma.raw(`"${table}"`);
  const doomed = Prisma.sql`SELECT id FROM doomed`;
  return Prisma.sql`
    WITH doomed AS (SELECT ${Prisma.raw(alias)}.id FROM ${name} ${Prisma.raw(
    alias
  )} WHERE ${where}),
      ${detachHeldThreadsCte(parents(doomed), markerView)}
    DELETE FROM ${name} WHERE id IN (${doomed}) ${returning}`;
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
    )
    SELECT 1 FROM below WHERE ${accountHoldSql(Prisma.sql`below."userId"`, markerView)}
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
 * Whether the thread `seed` selects is in a detached tree: it or any thread above it, up the reply
 * chain or to its root, was detached from a deleted parent.
 */
const detachedAboveSql = (seed: string) => Prisma.sql`
  ${Prisma.raw(threadAncestorsCte(seed))}
  SELECT EXISTS (
    SELECT 1
    FROM (
      SELECT mt."id" FROM thread_ancestors mt
      UNION ALL
      SELECT t."rootThreadId" FROM thread_ancestors mt JOIN "Thread" t ON t.id = mt."id"
    ) chain
    JOIN "Thread" th ON th.id = chain."id"
    WHERE th.metadata -> 'detachedFrom' IS NOT NULL
  ) AS detached`;

export const threadDetachedSql = (threadId: number) => detachedAboveSql(String(Number(threadId)));

export const commentDetachedSql = (commentId: number) =>
  detachedAboveSql(`(SELECT c."threadId" FROM "CommentV2" c WHERE c.id = ${Number(commentId)})`);
