import type { ReactionEntityType } from '~/server/schema/reaction.schema';
import { reactableEntities } from '~/server/schema/reaction.schema';
import type { PrismaClient } from '@prisma/client';
import { chunk, groupBy } from 'lodash-es';
import { createBuzzEvent } from '../base.reward';

const CUTOFF_DAYS = 30;
const type = 'goodContent' as const;
export const goodContentReward = createBuzzEvent({
  type,
  toAccountType: 'blue',
  includeTypes: reactableEntities.map((x) => `${type}:${x}`),
  description: 'Content that you posted was liked by someone else',
  triggerDescription: 'For each user that reacts to anything you created in the last 30 days',
  awardAmount: 2,
  caps: [
    {
      keyParts: ['toUserId'],
      interval: 'day',
      amount: 100,
    },
  ],
  getTransactionDetails: async (input: ReactionEvent, ctx) => {
    return {
      entityId: input.entityId,
      entityType: typeToTable[input.type],
    };
  },
  getKey: async (input: ReactionEvent, { db }) => {
    if (input.ownerId === input.reactorId) return false;

    // A comment's author is read from CommentV3; the transaction keeps its CommentV2 type.
    const table = input.type === 'comment' ? 'CommentV3' : typeToTable[input.type];
    if (!table) return false;
    try {
      const [{ userId } = { userId: undefined }] = await db.$queryRawUnsafe<{ userId?: number }[]>(`
        SELECT "userId"
        FROM "${table}"
        WHERE "createdAt" >= now() - INTERVAL '${CUTOFF_DAYS} days'
          AND id = ${input.entityId} AND "userId" != ${input.reactorId}
      `);

      if (!userId) return false;

      return {
        toUserId: userId,
        forId: input.entityId,
        byUserId: input.reactorId,
        type: `${type}:${input.type}`,
      };
    } catch (e) {
      return false;
    }
  },
  // Pays only for a reaction still present when the job runs (`process-rewards` holds every
  // event for its settle window first). Any reaction value counts, so swapping one for another
  // still pays. A failed read throws, leaving the events pending for the job to retry.
  preprocess: async ({ db, toProcess }) => {
    const byEntityType = groupBy(toProcess, (event) => event.type.split(':')[1]);
    for (const [entityType, events] of Object.entries(byEntityType)) {
      const present = new Set<string>();
      for (const batch of chunk(events, 1000)) {
        const entityIds = [...new Set(batch.map((event) => Number(event.forId)))];
        const userIds = [...new Set(batch.map((event) => Number(event.byUserId)))];
        const rows = await findReactions(db, entityType, entityIds, userIds);
        for (const row of rows) present.add(`${row.entityId}:${row.userId}`);
      }
      for (const event of events) {
        if (present.has(`${Number(event.forId)}:${Number(event.byUserId)}`)) continue;
        event.status = 'unqualified';
        event.awardAmount = 0;
      }
    }
  },
});

const typeToTable: Partial<Record<ReactionEntityType, string>> = {
  comment: 'CommentV2',
  image: 'Image',
  article: 'Article',
};

// primary: the job's client. A replica lagging past the settle window would miss a reaction still
// present and drop its reward.
async function findReactions(
  db: PrismaClient,
  entityType: string,
  entityIds: number[],
  userIds: number[]
): Promise<{ entityId: number; userId: number }[]> {
  switch (entityType as ReactionEntityType) {
    case 'image':
      return (
        await db.imageReaction.findMany({
          where: { imageId: { in: entityIds }, userId: { in: userIds } },
          select: { imageId: true, userId: true },
        })
      ).map((row) => ({ entityId: row.imageId, userId: row.userId }));
    case 'article':
      return (
        await db.articleReaction.findMany({
          where: { articleId: { in: entityIds }, userId: { in: userIds } },
          select: { articleId: true, userId: true },
        })
      ).map((row) => ({ entityId: row.articleId, userId: row.userId }));
    case 'comment':
      return (
        await db.commentV3Reaction.findMany({
          where: { commentId: { in: entityIds }, userId: { in: userIds } },
          select: { commentId: true, userId: true },
        })
      ).map((row) => ({ entityId: row.commentId, userId: row.userId }));
    default:
      return [];
  }
}

type ReactionEvent = {
  type: ReactionEntityType;
  reactorId: number;
  entityId: number;
  ownerId?: number;
};
