import { createBuzzEvent } from '../base.reward';

// TODO.buzz-merchant: Apply this reward in the right places in code.
export const imagePostedToModelReward = createBuzzEvent({
  type: 'imagePostedToModel',
  description: 'Image posted to a model you own',
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
  getKey: async (
    input: { modelVersionId: number; posterId: number; modelOwnerId?: number },
    ctx
  ) => {
    if (!input.modelOwnerId) {
      const [{ userId }] = await ctx.db.$queryRaw<[{ userId: number }]>`
        SELECT m."userId"
        FROM "ModelVersion" mv
        JOIN "Model" m ON m."id" = mv."modelId"
        WHERE mv.id = ${input.modelVersionId}
      `;
      input.modelOwnerId = userId;
    }

    return {
      toUserId: input.modelOwnerId,
      forId: input.modelVersionId,
      byUserId: input.posterId,
    };
  },
});
