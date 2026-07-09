import type { CollectionType } from '~/shared/utils/prisma/enums';
import { createBuzzEvent } from '../base.reward';

const type = 'collectedContent' as const;
const supported: CollectionType[] = ['Model', 'Image', 'Article'];
export const collectedContentReward = createBuzzEvent({
  type,
  toAccountType: 'blue',
  includeTypes: supported.map((x) => `${type}:${x.toLowerCase()}`),
  description: 'Content that you posted was collected by someone else',
  triggerDescription: 'For each time a user collects your content',
  tooltip:
    "When a user loves your content, they can add it to one of their Collections. You'll be rewarded each time this happens.",
  awardAmount: 2,
  caps: [
    {
      keyParts: ['toUserId'],
      interval: 'day',
      amount: 100,
    },
  ],
  getKey: async (input: CollectionEvent, { db }) => {
    if (!supported.includes(input.entityType)) return false;

    if (!input.ownerId) {
      const [{ userId } = { userId: undefined }] = await db.$queryRawUnsafe<{ userId?: number }[]>(`
        SELECT "userId"
        FROM "${input.entityType}"
        WHERE id = ${input.entityId}
      `);

      input.ownerId = userId;
    }

    // No owner resolved (entity missing/deleted, or an id that isn't this type) or self-collect → no reward.
    // The guard on the destructure above (matching goodContent.reward) prevents a `[]` result from throwing
    // "Cannot read properties of undefined (reading 'userId')" out of this inline reward and 500-ing the
    // user's collection.saveItem.
    if (!input.ownerId || input.ownerId === input.collectorId) return false;

    return {
      toUserId: input.ownerId,
      forId: input.entityId,
      byUserId: input.collectorId,
      type: `${type}:${input.entityType.toLowerCase()}`,
    };
  },
  getTransactionDetails: async (input: CollectionEvent, ctx) => {
    return {
      entityId: input.entityId,
      entityType: input.entityType,
    };
  },
});

type CollectionEvent = {
  collectorId: number;
  entityType: CollectionType;
  entityId: number;
  ownerId?: number;
};
