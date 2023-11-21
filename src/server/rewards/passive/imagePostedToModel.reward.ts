import { createBuzzEvent } from '../base.reward';
import { CollectionType } from '@prisma/client';

export const imagePostedToModelReward = createBuzzEvent({
  type: 'imagePostedToModel',
  description: 'Image posted to a model you own',
  triggerDescription: 'For each user that posts an image to your model',
  awardAmount: 50,
  caps: [
    {
      keyParts: ['toUserId'],
      interval: 'month',
      amount: 50000,
    },
    {
      keyParts: ['toUserId', 'forId'],
      amount: 5000,
    },
  ],
  getTransactionDetails: async (input: ImagePostedToModelEvent, ctx) => {
    if (!input.modelId) {
      return undefined;
    }

    return {
      entityId: input.modelId,
      entityType: 'Model',
    };
  },
  getKey: async (input: ImagePostedToModelEvent, ctx) => {
    if (!input.modelOwnerId) {
      const [{ userId }] = await ctx.db.$queryRaw<[{ userId: number }]>`
        SELECT m."userId"
        FROM "ModelVersion" mv
        JOIN "Model" m ON m."id" = mv."modelId"
        WHERE mv.id = ${input.modelVersionId}
      `;
      input.modelOwnerId = userId;
    }
    if (input.modelOwnerId === input.posterId) return false;

    return {
      toUserId: input.modelOwnerId,
      forId: input.modelVersionId,
      byUserId: input.posterId,
    };
  },
});

type ImagePostedToModelEvent = {
  modelId?: number;
  modelVersionId: number;
  posterId: number;
  modelOwnerId?: number;
};
