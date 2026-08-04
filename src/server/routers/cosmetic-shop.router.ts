import { getByIdSchema } from '~/server/schema/base.schema';
import { getAllowedAccountTypes } from '~/server/utils/buzz-helpers';
import {
  getAllCosmeticShopSections,
  getPaginatedCosmeticShopItemInput,
  getPreviewImagesInput,
  getShopInput,
  purchaseCosmeticShopItemInput,
  toggleWishlistShopItemInput,
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
  getWishlistedShopItemIds,
  purchaseCosmeticShopItem,
  reorderCosmeticShopSections,
  toggleWishlistShopItem,
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
import { TokenScope } from '~/shared/constants/token-scope.constants';
import { throwAuthorizationError } from '~/server/utils/errorHandling';
import { CosmeticType } from '~/shared/utils/prisma/enums';

export const cosmeticShopRouter = router({
  // #region [Shop Items]
  getShopItemsPaged: moderatorProcedure
    .input(getPaginatedCosmeticShopItemInput)
    .query(({ input }) => {
      return getPaginatedCosmeticShopItems(input);
    }),
  getShopItemById: protectedProcedure
    .meta({ requiredScope: TokenScope.CollectionsRead })
    .input(getByIdSchema)
    .query(({ input }) => {
      return getShopItemById(input);
    }),
  upsertCosmetic: moderatorProcedure.input(upsertCosmeticInput).mutation(({ input, ctx }) => {
    // Same gate as the creator path: creating stickers is flag-controlled, even
    // for mods. Rendering and owning them are not.
    if (input.type === CosmeticType.Sticker && !ctx.features.stickers)
      throw throwAuthorizationError('Stickers are not available yet');
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
  getSectionById: protectedProcedure
    .meta({ requiredScope: TokenScope.CollectionsRead })
    .input(getByIdSchema)
    .query(({ input }) => {
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
  getShop: publicProcedure
    .meta({ requiredScope: TokenScope.CollectionsRead })
    .input(getShopInput)
    .query(({ input, ctx }) => {
      return getShopSectionsWithItems({
        ...input,
        isModerator: ctx?.user?.isModerator,
        creatorShopEnabled: ctx?.features?.creatorShop,
        stickersEnabled: ctx?.features?.stickers,
        userId: ctx?.user?.id,
      });
    }),
  purchaseShopItem: verifiedProcedure
    .meta({ requiredScope: TokenScope.CollectionsWrite, blockApiKeys: true })
    .input(purchaseCosmeticShopItemInput)
    .mutation(({ input, ctx }) => {
      // Calculate domain-allowed account types at router level
      const [buzzType] = getAllowedAccountTypes(ctx.features);

      return purchaseCosmeticShopItem({
        ...input,
        stickersEnabled: ctx.features.stickers,
        userId: ctx.user.id,
        buzzType,
      });
    }),
  getWishlistedShopItemIds: protectedProcedure
    .meta({ requiredScope: TokenScope.CollectionsRead })
    .query(({ ctx }) => {
      return getWishlistedShopItemIds({ userId: ctx.user.id });
    }),
  toggleWishlistShopItem: protectedProcedure
    .meta({ requiredScope: TokenScope.CollectionsWrite })
    .input(toggleWishlistShopItemInput)
    .mutation(({ input, ctx }) => {
      return toggleWishlistShopItem({ ...input, userId: ctx.user.id });
    }),
  getPreviewImages: protectedProcedure
    .meta({ requiredScope: TokenScope.CollectionsRead })
    .input(getPreviewImagesInput)
    .query(({ input, ctx }) => {
      return getUserPreviewImagesForCosmetics({
        userId: ctx.user.id,
        features: ctx.features,
        ...input,
      });
    }),
  // #endregion
});
