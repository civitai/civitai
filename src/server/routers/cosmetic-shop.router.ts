import { getByIdSchema } from '~/server/schema/base.schema';
import {
  getAllCosmeticShopSections,
  getPaginatedCosmeticShopItemInput,
  getPreviewImagesInput,
  getShopInput,
  purchaseCosmeticShopItemInput,
  updateCosmeticShopSectionsOrderInput,
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
  upsertCosmeticShopItem,
  upsertCosmeticShopSection,
} from '~/server/services/cosmetic-shop.service';
import { moderatorProcedure, protectedProcedure, publicProcedure, router } from '~/server/trpc';

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
  purchaseShopItem: protectedProcedure
    .input(purchaseCosmeticShopItemInput)
    .mutation(({ input, ctx }) => {
      return purchaseCosmeticShopItem({
        ...input,
        userId: ctx.user.id,
      });
    }),
  getPreviewImages: protectedProcedure.input(getPreviewImagesInput).query(({ input, ctx }) => {
    return getUserPreviewImagesForCosmetics({
      userId: ctx.user.id,
      ...input,
    });
  }),
  // #endregion
});
