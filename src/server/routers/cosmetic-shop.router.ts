import { itemHolderInFlightLimit } from '~/server/middleware.trpc';
import { getByIdSchema } from '~/server/schema/base.schema';
import { getAllowedAccountTypes } from '~/server/utils/buzz-helpers';
import { getRegion } from '~/server/utils/region-blocking';
import { creatorMysteryPacksEnabled } from '~/server/schema/creator-shop.schema';
import {
  getAllCosmeticShopSections,
  getPaginatedCosmeticShopItemInput,
  getPreviewImagesInput,
  getShopInput,
  purchaseCosmeticShopItemInput,
  setShopItemEventTagsInput,
  shopItemSectionInput,
  toggleWishlistShopItemInput,
  updateCosmeticShopSectionsOrderInput,
  upsertCosmeticInput,
  upsertCosmeticShopItemInput,
  upsertCosmeticShopSectionInput,
  shopItemsFeaturedHistoryInput,
} from '~/server/schema/cosmetic-shop.schema';
import {
  addShopItemToSection,
  deleteCosmeticShopItem,
  deleteCosmeticShopSection,
  getPaginatedCosmeticShopItems,
  getSectionById,
  getShopItemById,
  getEventTagSuggestions,
  getShopItemEventTags,
  getShopItemSections,
  getShopSections,
  getShopSectionsWithItems,
  getUserPreviewImagesForCosmetics,
  getWishlistedShopItemIds,
  purchaseCosmeticShopItem,
  removeShopItemFromSection,
  reorderCosmeticShopSections,
  setShopItemEventTags,
  toggleWishlistShopItem,
  upsertCosmetic,
  upsertCosmeticShopItem,
  upsertCosmeticShopSection,
} from '~/server/services/cosmetic-shop.service';
import { getShopItemsFeaturedHistory } from '~/server/services/cosmetic-shop-featured-log.service';
import {
  moderatorProcedure,
  protectedProcedure,
  publicProcedure,
  router,
  verifiedProcedure,
} from '~/server/trpc';
import { eventViewerOf } from '~/server/events/event-viewer';
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
  // Editor reads: the whole item, the way the upsert form round-trips it.
  getShopItemById: moderatorProcedure.input(getByIdSchema).query(({ input }) => {
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
        isModerator: ctx.user.isModerator,
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
  getSectionById: moderatorProcedure.input(getByIdSchema).query(({ input }) => {
    return getSectionById(input);
  }),
  upsertShopSection: moderatorProcedure
    .input(upsertCosmeticShopSectionInput)
    .mutation(({ input, ctx }) => {
      return upsertCosmeticShopSection({
        ...input,
        userId: ctx.user.id,
        tracker: ctx.track,
      });
    }),
  deleteShopSection: moderatorProcedure.input(getByIdSchema).mutation(({ input, ctx }) => {
    return deleteCosmeticShopSection({ ...input, tracker: ctx.track });
  }),
  updateSectionsOrder: moderatorProcedure
    .input(updateCosmeticShopSectionsOrderInput)
    .mutation(({ input }) => {
      return reorderCosmeticShopSections(input);
    }),
  getShopItemSections: moderatorProcedure
    .input(shopItemSectionInput.pick({ shopItemId: true }))
    .query(({ input }) => getShopItemSections(input)),
  addShopItemToSection: moderatorProcedure
    .input(shopItemSectionInput)
    .mutation(({ input, ctx }) => addShopItemToSection({ ...input, tracker: ctx.track })),
  removeShopItemFromSection: moderatorProcedure
    .input(shopItemSectionInput)
    .mutation(({ input, ctx }) => removeShopItemFromSection({ ...input, tracker: ctx.track })),
  getShopItemsFeaturedHistory: moderatorProcedure
    .input(shopItemsFeaturedHistoryInput)
    .query(({ input }) => getShopItemsFeaturedHistory(input)),
  // Event tags are moderator data: they decide what an official section sells.
  getShopItemEventTags: moderatorProcedure
    .input(shopItemSectionInput.pick({ shopItemId: true }))
    .query(({ input }) => getShopItemEventTags(input)),
  getEventTagSuggestions: moderatorProcedure.query(() => getEventTagSuggestions()),
  setShopItemEventTags: moderatorProcedure
    .input(setShopItemEventTagsInput)
    .mutation(({ input }) => setShopItemEventTags(input)),
  // #endregion
  // #region [Public facing routes]
  getShop: publicProcedure
    .meta({ requiredScope: TokenScope.CollectionsRead })
    .input(getShopInput)
    .query(({ input, ctx }) => {
      return getShopSectionsWithItems({
        ...input,
        isModerator: eventViewerOf(ctx).isModerator,
        creatorShopEnabled: ctx?.features?.creatorShop,
        stickersEnabled: ctx?.features?.stickers,
        userId: ctx?.user?.id,
      });
    }),
  purchaseShopItem: verifiedProcedure
    .meta({ requiredScope: TokenScope.CollectionsWrite, blockApiKeys: true })
    .input(purchaseCosmeticShopItemInput)
    .use(itemHolderInFlightLimit)
    .mutation(({ input, ctx }) => {
      // Calculate domain-allowed account types at router level
      const [buzzType] = getAllowedAccountTypes(ctx.features);

      return purchaseCosmeticShopItem({
        ...input,
        stickersEnabled: ctx.features.stickers,
        packsEnabled: ctx.features.cosmeticPacks,
        mysteryBoxEnabled: ctx.features.mysteryBox,
        creatorMysteryPacksEnabled: creatorMysteryPacksEnabled(ctx.features),
        countryCode: ctx.req ? getRegion(ctx.req).countryCode : null,
        userId: ctx.user.id,
        isModerator: eventViewerOf(ctx).isModerator,
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
