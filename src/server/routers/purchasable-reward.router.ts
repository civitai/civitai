import { getByIdSchema } from '~/server/schema/base.schema';
import {
  purchasableRewardPurchaseSchema,
  purchasableRewardUpsertSchema,
  getPaginatedPurchasableRewardsSchema,
  getPaginatedPurchasableRewardsModeratorSchema,
} from '~/server/schema/purchasable-reward.schema';
import {
  getPaginatedPurchasableRewards,
  purchasableRewardUpsert,
  purchasableRewardPurchase,
  getPurchasableReward,
  getPaginatedPurchasableRewardsModerator,
} from '~/server/services/purchasable-reward.service';
import { moderatorProcedure, protectedProcedure, publicProcedure, router } from '~/server/trpc';
import { getAllowedAccountTypes } from '~/server/utils/buzz-helpers';

export const purchasableRewardRouter = router({
  getPaged: publicProcedure.input(getPaginatedPurchasableRewardsSchema).query(({ input, ctx }) => {
    return getPaginatedPurchasableRewards({ ...input, userId: ctx?.user?.id });
  }),
  getModeratorPaged: moderatorProcedure
    .input(getPaginatedPurchasableRewardsModeratorSchema)
    .query(({ input }) => {
      return getPaginatedPurchasableRewardsModerator(input);
    }),
  upsert: moderatorProcedure.input(purchasableRewardUpsertSchema).mutation(({ input, ctx }) => {
    return purchasableRewardUpsert({ ...input, userId: ctx.user.id });
  }),
  purchase: protectedProcedure.input(purchasableRewardPurchaseSchema).mutation(({ input, ctx }) => {
    return purchasableRewardPurchase({
      ...input,
      userId: ctx.user.id,
      buzzType: getAllowedAccountTypes(ctx.features)[0],
    });
  }),
  getById: moderatorProcedure.input(getByIdSchema).query(({ input }) => {
    return getPurchasableReward(input);
  }),
});
