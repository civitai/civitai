import { getByIdSchema } from '~/server/schema/base.schema';
import {
  getCommunityCosmeticsSchema,
  getCreatorShopSchema,
  getCreatorShopSettingsSchema,
  getEarlyAccessPricesSchema,
  getManageItemsSchema,
  getPublicShopItemsSchema,
  getReviewQueueSchema,
  resoldItemSchema,
  reviewCreatorShopItemSchema,
  setCreatorShopItemListedSchema,
  submitCreatorShopItemSchema,
  updateCreatorShopItemSchema,
  updateCreatorShopSettingsSchema,
} from '~/server/schema/creator-shop.schema';
import {
  archiveCreatorShopItem,
  setCreatorShopItemListed,
  deleteCreatorShopItem,
  getCommunityCosmetics,
  getCreatorShop,
  getCreatorShopManageItems,
  getEarlyAccessModelPrices,
  addResoldItem,
  getPublicShopItemsForResale,
  getResoldItemsForManage,
  removeResoldItem,
  getCreatorShopReviewQueue,
  getCreatorShopSettings,
  reviewCreatorShopItem,
  submitCreatorShopItem,
  unarchiveCreatorShopItem,
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
// server-side (the flag also hides the UI). The flag falls back to `['mod']` but
// is Flipt-controllable (`creator-shop`), so testers can be unlocked without a
// deploy. Shops are open to all users (ClickUp 868kj4q5a) — the flag is the only
// gate.
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
  setItemListed: creatorShopProcedure
    .input(setCreatorShopItemListedSchema)
    .mutation(({ input, ctx }) =>
      setCreatorShopItemListed({
        id: input.id,
        listed: input.listed,
        userId: ctx.user.id,
        isModerator: ctx.user.isModerator,
      })
    ),
  unarchiveItem: creatorShopProcedure.input(getByIdSchema).mutation(({ input, ctx }) =>
    unarchiveCreatorShopItem({
      id: input.id,
      userId: ctx.user.id,
      isModerator: ctx.user.isModerator,
    })
  ),
  deleteItem: creatorShopProcedure.input(getByIdSchema).mutation(({ input, ctx }) =>
    deleteCreatorShopItem({
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
  // Cross-creator selling: browse public cosmetics + list one in your own shop.
  getPublicShopItems: creatorShopProcedure
    .input(getPublicShopItemsSchema)
    .query(({ input, ctx }) => getPublicShopItemsForResale({ ...input, userId: ctx.user.id })),
  getResoldItems: creatorShopProcedure.query(({ ctx }) =>
    getResoldItemsForManage({ userId: ctx.user.id })
  ),
  addResoldItem: creatorShopProcedure
    .input(resoldItemSchema)
    .mutation(({ input, ctx }) => addResoldItem({ ...input, userId: ctx.user.id })),
  removeResoldItem: creatorShopProcedure
    .input(resoldItemSchema)
    .mutation(({ input, ctx }) => removeResoldItem({ ...input, userId: ctx.user.id })),
  // #endregion

  // #region [Public: storefront]
  getShop: publicProcedure
    .use(isFlagProtected('creatorShop'))
    .input(getCreatorShopSchema)
    .query(({ input, ctx }) =>
      getCreatorShop({
        ...input,
        viewerId: ctx.user?.id,
        isModerator: ctx.user?.isModerator,
        preview: input.preview && !!ctx.user?.isModerator,
      })
    ),
  getEarlyAccessPrices: publicProcedure
    .use(isFlagProtected('creatorShop'))
    .input(getEarlyAccessPricesSchema)
    .query(({ input }) => getEarlyAccessModelPrices(input)),
  // Site-wide community cosmetics hub feed on /shop.
  getCommunityCosmetics: publicProcedure
    .use(isFlagProtected('creatorShop'))
    .input(getCommunityCosmeticsSchema)
    .query(({ input, ctx }) => getCommunityCosmetics({ ...input, viewerId: ctx.user?.id })),
  // #endregion

  // #region [Shop settings]
  getSettings: creatorShopProcedure.input(getCreatorShopSettingsSchema).query(({ input, ctx }) =>
    getCreatorShopSettings({
      userId: ctx.user.isModerator && input.userId ? input.userId : ctx.user.id,
    })
  ),
  updateSettings: creatorShopProcedure
    .input(updateCreatorShopSettingsSchema)
    .mutation(({ input, ctx }) => {
      const { userId: targetUserId, ...patch } = input;
      const userId = ctx.user.isModerator && targetUserId ? targetUserId : ctx.user.id;
      return updateCreatorShopSettings({ ...patch, userId });
    }),
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
