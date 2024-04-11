import { getByIdSchema } from '~/server/schema/base.schema';
import {
  getAllCosmeticShopSections,
  getPaginatedCosmeticShopItemInput,
  upsertCosmeticShopItemInput,
  upsertCosmeticShopSectionInput,
} from '~/server/schema/cosmetic-shop.schema';
import {
  getPaginatedCosmeticShopItems,
  getSectionById,
  getShopItemById,
  getShopSections,
  upsertCosmeticShopItem,
  upsertCosmeticShopSection,
} from '~/server/services/cosmetic-shop.service';
import { moderatorProcedure, protectedProcedure, router } from '~/server/trpc';

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
  // #endregion
});
