import { Prisma } from '@prisma/client';
import { dbWrite } from '~/server/db/client';
import { onReactionRemoved } from '~/server/events/points/hooks';
import {
  answerMetrics,
  articleMetrics,
  bountyEntryMetrics,
  postMetrics,
  questionMetrics,
} from '~/server/metrics';

/**
 * Every table a user's reactions live in, with the follow-up the one-at-a-time un-react path
 * (`reaction.service.ts`) runs after its delete, so a bulk erasure leaves the counts where that path
 * would have.
 *
 * - `queue`: the Postgres metric whose rows are recomputed only for queued ids.
 * - Image, Article and BountyEntry counts in ClickHouse and Redis follow the DELETE itself: those tables
 *   are REPLICA IDENTITY FULL and the event engine's reaction handlers emit the -1 from CDC.
 * - CommentV2Reaction's count is a trigger on the table. CommentReaction, ResourceReviewReaction and
 *   ClubPostReaction have no counter.
 */
const TABLES = [
  { table: 'ImageReaction', fk: 'imageId', points: 'image' },
  { table: 'ArticleReaction', fk: 'articleId', queue: articleMetrics, points: 'article' },
  { table: 'PostReaction', fk: 'postId', queue: postMetrics },
  { table: 'BountyEntryReaction', fk: 'bountyEntryId', queue: bountyEntryMetrics },
  { table: 'CommentV2Reaction', fk: 'commentId' },
  { table: 'CommentReaction', fk: 'commentId' },
  { table: 'ResourceReviewReaction', fk: 'reviewId' },
  { table: 'ClubPostReaction', fk: 'clubPostId' },
  { table: 'QuestionReaction', fk: 'questionId', queue: questionMetrics },
  { table: 'AnswerReaction', fk: 'answerId', queue: answerMetrics },
] as const;

export type ReactionTable = (typeof TABLES)[number]['table'];
export type ReactionCounts = Record<ReactionTable, number>;

/**
 * Image reactions are removed at most this many per call, in batches of `IMAGE_BATCH`: an account can hold
 * hundreds of thousands, each deleted row is a CDC event the event engine fans out into three metric rows,
 * and the call has to finish inside the gateway's 30s. The caller runs it again while `remaining` > 0.
 */
export const IMAGE_ROWS_PER_RUN = 25_000;
const IMAGE_BATCH = 5_000;

export async function countUserReactions(userId: number): Promise<ReactionCounts> {
  const rows = await dbWrite.$queryRaw<{ table: ReactionTable; n: number }[]>(
    Prisma.join(
      TABLES.map(
        ({ table }) =>
          Prisma.sql`SELECT ${table} AS "table", count(*)::int AS n FROM ${Prisma.raw(
            `"${table}"`
          )} WHERE "userId" = ${userId}`
      ),
      ' UNION ALL '
    )
  );
  const counts = Object.fromEntries(TABLES.map(({ table }) => [table, 0])) as ReactionCounts;
  for (const row of rows) counts[row.table] = Number(row.n);
  return counts;
}

async function deleteReturning(
  table: ReactionTable,
  fk: string,
  userId: number,
  limit?: number
): Promise<number[]> {
  const t = Prisma.raw(`"${table}"`);
  const col = Prisma.raw(`"${fk}"`);
  const rows = await dbWrite.$queryRaw<{ entityId: number }[]>(
    limit === undefined
      ? Prisma.sql`DELETE FROM ${t} WHERE "userId" = ${userId} RETURNING ${col} AS "entityId"`
      : // BountyEntryReaction has no id column, but it is never batched.
        Prisma.sql`DELETE FROM ${t} WHERE id IN (
          SELECT id FROM ${t} WHERE "userId" = ${userId} LIMIT ${limit}
        ) RETURNING ${col} AS "entityId"`
  );
  return rows.map((r) => r.entityId);
}

/**
 * Deletes the user's reactions from every table, image reactions up to `IMAGE_ROWS_PER_RUN`, and runs
 * the follow-ups the un-react path runs. Returns what was removed and how many image reactions remain.
 */
export async function removeUserReactions(userId: number): Promise<{
  removed: ReactionCounts;
  remaining: number;
}> {
  const removed = Object.fromEntries(TABLES.map(({ table }) => [table, 0])) as ReactionCounts;

  for (const def of TABLES) {
    let entityIds: number[] = [];
    if (def.table === 'ImageReaction') {
      while (entityIds.length < IMAGE_ROWS_PER_RUN) {
        const batch = await deleteReturning(def.table, def.fk, userId, IMAGE_BATCH);
        entityIds.push(...batch);
        if (batch.length < IMAGE_BATCH) break;
      }
    } else {
      entityIds = await deleteReturning(def.table, def.fk, userId);
    }
    removed[def.table] = entityIds.length;
    if (!entityIds.length) continue;

    const distinct = [...new Set(entityIds)];
    if ('queue' in def) await def.queue.queueUpdate(distinct);
    // Never throws; returns early for anything outside a scored event.
    if ('points' in def)
      for (const entityId of distinct)
        await onReactionRemoved({ entityType: def.points, entityId, userId });
  }

  const [{ remaining }] = await dbWrite.$queryRaw<{ remaining: number }[]>`
    SELECT count(*)::int AS remaining FROM "ImageReaction" WHERE "userId" = ${userId}
  `;
  return { removed, remaining: Number(remaining) };
}
