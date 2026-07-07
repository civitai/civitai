import { getByIdSchema } from '~/server/schema/base.schema';
import {
  getCreatorShopSchema,
  getManageItemsSchema,
  getReviewQueueSchema,
  reviewCreatorShopItemSchema,
  submitCreatorShopItemSchema,
  updateCreatorShopItemSchema,
  updateCreatorShopSettingsSchema,
} from '~/server/schema/creator-shop.schema';
import {
  archiveCreatorShopItem,
  getCreatorShop,
  getCreatorShopManageItems,
  getCreatorShopReviewQueue,
  getCreatorShopSettings,
  reviewCreatorShopItem,
  submitCreatorShopItem,
  updateCreatorShopItem,
  updateCreatorShopSettings,
} from '~/server/services/creator-shop.service';
import {
  isFlagProtected,
  moderatorProcedure,
  protectedProcedure,
  publicProcedure,
  router,
} from '~/server/trpc';

// Every Creator Shop endpoint is gated on the `creatorShop` feature flag
// server-side (the flag also hides the UI). While the flag resolves to `['mod']`
// this contains the whole feature to moderators. When it rolls out more broadly,
// the creator mutations still need a Creator-Program eligibility check added here
// (see getCreatorRequirements) — the flag gate alone is not sufficient at GA.
const creatorShopProcedure = protectedProcedure.use(isFlagProtected('creatorShop'));

export const creatorShopRouter = router({
  // #region [Creator: submit & manage]
  submitItem: creatorShopProcedure
    .input(submitCreatorShopItemSchema)
    .mutation(({ input, ctx }) => submitCreatorShopItem({ ...input, userId: ctx.user.id })),
  updateItem: creatorShopProcedure
    .input(updateCreatorShopItemSchema)
    .mutation(({ input, ctx }) =>
      updateCreatorShopItem({ ...input, userId: ctx.user.id, isModerator: ctx.user.isModerator })
    ),
  archiveItem: creatorShopProcedure.input(getByIdSchema).mutation(({ input, ctx }) =>
    archiveCreatorShopItem({
      id: input.id,
      userId: ctx.user.id,
      isModerator: ctx.user.isModerator,
    })
  ),
  // Moderators may inspect another creator's shop by passing their userId.
  getManageItems: creatorShopProcedure.input(getManageItemsSchema).query(({ input, ctx }) =>
    getCreatorShopManageItems({
      userId: ctx.user.isModerator && input.userId ? input.userId : ctx.user.id,
    })
  ),
  // #endregion

  // #region [Public: storefront]
  getShop: publicProcedure
    .use(isFlagProtected('creatorShop'))
    .input(getCreatorShopSchema)
    .query(({ input }) => getCreatorShop(input)),
  // #endregion

  // #region [Shop settings]
  getSettings: creatorShopProcedure.query(({ ctx }) =>
    getCreatorShopSettings({ userId: ctx.user.id })
  ),
  updateSettings: creatorShopProcedure
    .input(updateCreatorShopSettingsSchema)
    .mutation(({ input, ctx }) => updateCreatorShopSettings({ ...input, userId: ctx.user.id })),
  // #endregion

  // #region [Moderator: review queue]
  getReviewQueue: moderatorProcedure
    .use(isFlagProtected('creatorShop'))
    .input(getReviewQueueSchema)
    .query(({ input }) => getCreatorShopReviewQueue(input)),
  reviewItem: moderatorProcedure
    .use(isFlagProtected('creatorShop'))
    .input(reviewCreatorShopItemSchema)
    .mutation(({ input, ctx }) => reviewCreatorShopItem({ ...input, reviewerId: ctx.user.id })),
  // #endregion
});
