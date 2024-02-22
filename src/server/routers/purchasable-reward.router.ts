import {
  purchasableRewardPurchaseSchema,
  purchasableRewardUpsertSchema,
  getPaginatedPurchasableRewardsSchema,
} from '~/server/schema/purchasable-reward.schema';
import {
  getPaginatedPurchasableRewards,
  purchasableRewardUpsert,
  purchasableRewardPurchase,
} from '~/server/services/purchasable-reward.service';
import { moderatorProcedure, protectedProcedure, publicProcedure, router } from '~/server/trpc';

export const purchasableRewardRouter = router({
  getPaged: publicProcedure.input(getPaginatedPurchasableRewardsSchema).query(({ input }) => {
    return getPaginatedPurchasableRewards(input);
  }),
  upsert: moderatorProcedure.input(purchasableRewardUpsertSchema).mutation(({ input, ctx }) => {
    return purchasableRewardUpsert({ ...input, userId: ctx.user.id });
  }),
  purchase: protectedProcedure.input(purchasableRewardPurchaseSchema).mutation(({ input, ctx }) => {
    return purchasableRewardPurchase({ ...input, userId: ctx.user.id });
  }),
});
