import { getByIdSchema } from '~/server/schema/base.schema';
import { getAllowedAccountTypes } from '~/server/utils/buzz-helpers';
import {
  getAllCosmeticShopSections,
  getPaginatedCosmeticShopItemInput,
  getPreviewImagesInput,
  getShopInput,
  purchaseCosmeticShopItemInput,
  updateCosmeticShopSectionsOrderInput,
  upsertCosmeticInput,
  upsertCosmeticShopItemInput,
  upsertCosmeticShopSectionInput,
} from '~/server/schema/cosmetic-shop.schema';
import {
  deleteCosmeticShopItem,
  deleteCosmeticShopSection,
  getPaginatedCosmeticShopItems,
  getSectionById,
  getShopItemById,
  getShopSections,
  getShopSectionsWithItems,
  getUserPreviewImagesForCosmetics,
  purchaseCosmeticShopItem,
  reorderCosmeticShopSections,
  upsertCosmetic,
  upsertCosmeticShopItem,
  upsertCosmeticShopSection,
} from '~/server/services/cosmetic-shop.service';
import {
  moderatorProcedure,
  protectedProcedure,
  publicProcedure,
  router,
  verifiedProcedure,
} from '~/server/trpc';

export const cosmeticShopRouter = router({
  // #region [Shop Items]
  getShopItemsPaged: moderatorProcedure
    .input(getPaginatedCosmeticShopItemInput)
    .query(({ input }) => {
      return getPaginatedCosmeticShopItems(input);
    }),
  getShopItemById: protectedProcedure.input(getByIdSchema).query(({ input }) => {
    return getShopItemById(input);
  }),
  upsertCosmetic: moderatorProcedure.input(upsertCosmeticInput).mutation(({ input }) => {
    return upsertCosmetic(input);
  }),
  upsertShopItem: moderatorProcedure
    .input(upsertCosmeticShopItemInput)
    .mutation(({ input, ctx }) => {
      return upsertCosmeticShopItem({
        ...input,
        userId: ctx.user.id,
      });
    }),
  deleteShopItem: moderatorProcedure.input(getByIdSchema).mutation(({ input }) => {
    return deleteCosmeticShopItem(input);
  }),
  // #endregion
  // #region [Sections]
  getAllSections: moderatorProcedure.input(getAllCosmeticShopSections).query(({ input }) => {
    return getShopSections(input);
  }),
  getSectionById: protectedProcedure.input(getByIdSchema).query(({ input }) => {
    return getSectionById(input);
  }),
  upsertShopSection: moderatorProcedure
    .input(upsertCosmeticShopSectionInput)
    .mutation(({ input, ctx }) => {
      return upsertCosmeticShopSection({
        ...input,
        userId: ctx.user.id,
      });
    }),
  deleteShopSection: moderatorProcedure.input(getByIdSchema).mutation(({ input }) => {
    return deleteCosmeticShopSection(input);
  }),
  updateSectionsOrder: moderatorProcedure
    .input(updateCosmeticShopSectionsOrderInput)
    .mutation(({ input }) => {
      return reorderCosmeticShopSections(input);
    }),
  // #endregion
  // #region [Public facing routes]
  getShop: publicProcedure.input(getShopInput).query(({ input, ctx }) => {
    return getShopSectionsWithItems({
      ...input,
      isModerator: ctx?.user?.isModerator,
    });
  }),
  purchaseShopItem: verifiedProcedure
    .input(purchaseCosmeticShopItemInput)
    .mutation(({ input, ctx }) => {
      // Calculate domain-allowed account types at router level
      const allowedAccountTypes = getAllowedAccountTypes(ctx.features);

      return purchaseCosmeticShopItem({
        ...input,
        userId: ctx.user.id,
        buzzTypes: allowedAccountTypes,
      });
    }),
  getPreviewImages: protectedProcedure.input(getPreviewImagesInput).query(({ input, ctx }) => {
    return getUserPreviewImagesForCosmetics({
      userId: ctx.user.id,
      features: ctx.features,
      ...input,
    });
  }),
  // #endregion
});
