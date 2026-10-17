import { Prisma } from '@prisma/client';
import { clickhouse } from '~/server/clickhouse/client';
import { dbWrite } from '~/server/db/client';
import { onReactionRemoved } from '~/server/events/points/hooks';
import { logToAxiom } from '~/server/logging/client';
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
 * - `owner`: the content table whose author's all-time reactions-received score
 *   (`reactions_owner_scores`, which `UserMetric.reactionCount` reads) the un-react path lowers through
 *   a `*_Delete` tracker row. Nothing follows a SQL delete into that score, so it is lowered directly,
 *   per owner, without writing the reactor's id anywhere.
 */
const TABLES = [
  { table: 'ImageReaction', fk: 'imageId', points: 'image', owner: 'Image' },
  {
    table: 'ArticleReaction',
    fk: 'articleId',
    queue: articleMetrics,
    points: 'article',
    owner: 'Article',
  },
  { table: 'PostReaction', fk: 'postId', queue: postMetrics, owner: 'Post' },
  {
    table: 'BountyEntryReaction',
    fk: 'bountyEntryId',
    queue: bountyEntryMetrics,
    owner: 'BountyEntry',
  },
  { table: 'CommentV2Reaction', fk: 'commentId', owner: 'CommentV2' },
  { table: 'CommentReaction', fk: 'commentId', owner: 'Comment' },
  { table: 'ResourceReviewReaction', fk: 'reviewId' },
  { table: 'ClubPostReaction', fk: 'clubPostId' },
  { table: 'QuestionReaction', fk: 'questionId', queue: questionMetrics, owner: 'Question' },
  { table: 'AnswerReaction', fk: 'answerId', queue: answerMetrics, owner: 'Answer' },
] as const;

/** Every table name, for a guard that a new reaction table in the schema is listed here. */
export const REACTION_TABLES: readonly string[] = TABLES.map((t) => t.table);

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

    // The rows are gone once the DELETE commits, so a follow-up that fails cannot be retried by running
    // this again: it is logged with the ids it needed, and the rest of the erasure carries on.
    const distinct = [...new Set(entityIds)];
    await followUp(def.table, 'queue', distinct, async () => {
      if ('queue' in def) await def.queue.queueUpdate(distinct);
    });
    await followUp(def.table, 'ownerScore', distinct, async () => {
      if ('owner' in def) await lowerOwnerScores(def.owner, entityIds, userId);
    });
    await followUp(def.table, 'points', distinct, async () => {
      // Never throws; returns early for anything outside a scored event.
      if ('points' in def)
        for (const entityId of distinct)
          await onReactionRemoved({ entityType: def.points, entityId, userId });
    });
  }

  const [{ remaining }] = await dbWrite.$queryRaw<{ remaining: number }[]>`
    SELECT count(*)::int AS remaining FROM "ImageReaction" WHERE "userId" = ${userId}
  `;
  return { removed, remaining: Number(remaining) };
}

async function followUp(
  table: string,
  step: string,
  entityIds: number[],
  run: () => Promise<void>
) {
  try {
    await run();
  } catch (error) {
    logToAxiom({
      type: 'error',
      name: 'user-reaction-erasure-follow-up',
      message: (error as Error).message,
      details: { table, step, entityIds },
    }).catch(() => undefined);
  }
}

/**
 * One -1 per removed reaction on each owner's score: each surviving row is a +1 there, whatever the
 * reactor toggled before. A self-reaction is skipped because the score never counted it, and a reaction
 * on content that no longer exists is skipped because its owner can no longer be read.
 */
async function lowerOwnerScores(ownerTable: string, entityIds: number[], userId: number) {
  if (!clickhouse) return;
  const owners = await dbWrite.$queryRaw<{ id: number; ownerId: number }[]>(
    Prisma.sql`SELECT id, "userId" AS "ownerId" FROM ${Prisma.raw(
      `"${ownerTable}"`
    )} WHERE id = ANY(${[...new Set(entityIds)]}::int[])`
  );
  const ownerOf = new Map(owners.map((o) => [o.id, o.ownerId]));
  const removedPerOwner = new Map<number, number>();
  for (const entityId of entityIds) {
    const ownerId = ownerOf.get(entityId);
    if (!ownerId || ownerId === userId) continue;
    removedPerOwner.set(ownerId, (removedPerOwner.get(ownerId) ?? 0) + 1);
  }
  if (!removedPerOwner.size) return;
  await clickhouse.insert({
    table: 'reactions_owner_scores',
    values: [...removedPerOwner].map(([ownerId, n]) => ({ ownerId, score: -n })),
    format: 'JSONEachRow',
  });
}
