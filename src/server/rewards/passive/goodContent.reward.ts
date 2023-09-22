import { reactableEntities, ReactionEntityType } from '~/server/schema/reaction.schema';
import { createBuzzEvent } from '../base.reward';

const CUTOFF_DAYS = 30;
const type = 'goodContent' as const;
export const goodContentReward = createBuzzEvent({
  type,
  includeTypes: reactableEntities.map((x) => `${type}:${x}`),
  description: 'Content that you posted was liked by someone else',
  awardAmount: 2,
  caps: [
    {
      keyParts: ['toUserId'],
      interval: 'day',
      amount: 100,
    },
  ],
  getKey: async (input: ReactionEvent, { db }) => {
    const table = typeToTable[input.type];
    if (!table) return false;
    try {
      const [{ userId } = { userId: undefined }] = await db.$queryRawUnsafe<{ userId?: number }[]>(`
        SELECT "userId"
        FROM "${table}"
        WHERE "createdAt" >= NOW() - INTERVAL '${CUTOFF_DAYS} days'
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
      console.log(e);
      return false;
    }
  },
  // We already check for qualified entities in the getKey function
  // Leaving this as an example preprocessor
  /*
  preprocess: async ({ db, toProcess }) => {
    // Break into sets by entity type
    const sets = toProcess.reduce((sets, x) => {
      const entityType = x.type.split(':')[1];
      if (!sets[entityType]) sets[entityType] = [x];
      else sets[entityType].push(x);

      return sets;
    }, {} as Record<ReactionEntityType, BuzzEventLog[]>);

    // For each set, check if the entity is still qualified
    for (const [entityType, events] of Object.entries(sets)) {
      let qualifiedIds: number[] = [];

      // Get all qualified ids
      const table = typeToTable[entityType as ReactionEntityType];
      if (table) {
        const ids = new Set(events.map((x) => x.forId));
        qualifiedIds = (
          await db.$queryRawUnsafe<{ id: number }[]>(`
          SELECT id
          FROM "${table}"
          WHERE "createdAt" >= NOW() - INTERVAL '${CUTOFF_DAYS} days'
            AND id IN (${[...ids].join(',')})
        `)
        ).map((x) => x.id);
      }

      // Mark unqualified events
      for (const event of events) {
        const isQualified = qualifiedIds.length && qualifiedIds.includes(event.forId);
        if (!isQualified) {
          event.status = 'unqualified';
          event.awardAmount = 0;
        }
      }
    }
  },
  */
});

const typeToTable: Partial<Record<ReactionEntityType, string>> = {
  question: 'Question',
  answer: 'Answer',
  comment: 'CommentV2',
  commentOld: 'Comment',
  image: 'Image',
  article: 'Article',
};

type ReactionEvent = {
  type: ReactionEntityType;
  reactorId: number;
  entityId: number;
};
