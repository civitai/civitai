import { getByIdSchema } from '~/server/schema/base.schema';
import {
  equipCosmeticSchema,
  getStickerCosmeticsSchema,
  getPaginatedCosmeticsSchema,
  getViewerEventDecorationsSchema,
  purchaseStickerUsesSchema,
  setStickerPlacementRatingSchema,
  unequipCosmeticSchema,
  updateEventHatFitSchema,
} from '~/server/schema/cosmetic.schema';
import {
  setStickerPlacementRating,
  getCosmeticDetail,
  getStickerCosmetics,
  getStickerAttribution,
  getPaginatedCosmetics,
  equipCosmeticToEntity,
  getViewerEventDecorations,
  unequipCosmetic,
  updateEventHatFit,
} from '~/server/services/cosmetic.service';
import {
  getStickerBalances,
  getStickerOffers,
  getStickerRecentUse,
  purchaseStickerUses,
} from '~/server/services/sticker.service';
import { getAllowedAccountTypes } from '~/server/utils/buzz-helpers';
import { noEdgeCache, rateLimit } from '~/server/middleware.trpc';
import { CacheTTL } from '~/server/common/constants';
import {
  moderatorProcedure,
  protectedProcedure,
  publicProcedure,
  router,
  verifiedProcedure,
} from '~/server/trpc';
import { TokenScope } from '~/shared/constants/token-scope.constants';

export const cosmeticRouter = router({
  getById: protectedProcedure
    .meta({ requiredScope: TokenScope.CollectionsRead })
    .input(getByIdSchema)
    .query(({ input }) => {
      return getCosmeticDetail(input);
    }),
  getSticker: publicProcedure
    .meta({ requiredScope: TokenScope.CollectionsRead })
    .input(getStickerCosmeticsSchema)
    .query(({ input }) => {
      return getStickerCosmetics(input);
    }),
  // Who made a sticker and where to buy it, for the attribution card on an
  // inline sticker. Public: the answer is the same for every viewer, and the
  // sticker is already visible to anyone reading the comment.
  getStickerAttribution: publicProcedure
    .meta({ requiredScope: TokenScope.CollectionsRead })
    .input(getStickerCosmeticsSchema)
    .query(({ input }) => {
      return getStickerAttribution(input);
    }),
  // Remaining uses per owned sticker, so the picker can show a balance instead
  // of the user discovering it as a failed comment submit.
  getStickerBalances: protectedProcedure
    .meta({ requiredScope: TokenScope.CollectionsRead })
    .query(({ ctx }) => getStickerBalances(ctx.user.id)),
  // When the placer last reached for each of their stickers, which is what the
  // tray sorts by before it falls back to what they bought most recently.
  getStickerRecentUse: protectedProcedure
    .meta({ requiredScope: TokenScope.CollectionsRead })
    .query(({ ctx }) => getStickerRecentUse(ctx.user.id)),
  // What refilling a sticker costs, both ways: one more use, or another batch
  // through its listing where one is still on sale.
  getStickerOffers: protectedProcedure
    .meta({ requiredScope: TokenScope.CollectionsRead })
    .input(getStickerCosmeticsSchema)
    .query(({ input, ctx }) => getStickerOffers({ ...input, viewerId: ctx.user.id })),
  // Topping up a sticker the user already owns, offered where they run out.
  // Money moves, so it matches the shop purchase's procedure: verified account,
  // no API keys.
  purchaseStickerUses: verifiedProcedure
    .meta({ requiredScope: TokenScope.CollectionsWrite, blockApiKeys: true })
    .input(purchaseStickerUsesSchema)
    .mutation(({ input, ctx }) => {
      const [buzzType] = getAllowedAccountTypes(ctx.features);
      return purchaseStickerUses({
        ...input,
        userId: ctx.user.id,
        buzzType,
        stickersEnabled: ctx.features.stickers,
      });
    }),
  getPaged: moderatorProcedure.input(getPaginatedCosmeticsSchema).query(({ input }) => {
    return getPaginatedCosmetics(input);
  }),
  setStickerPlacementRating: moderatorProcedure
    .input(setStickerPlacementRatingSchema)
    .mutation(({ input }) => setStickerPlacementRating(input)),
  // Takes effect on every card wearing the hat at once; the editor previews it first.
  updateEventHatFit: moderatorProcedure
    .input(updateEventHatFitSchema)
    .mutation(({ input }) => updateEventHatFit(input)),
  // The viewer's own preview hats, for cards served from a cache every viewer shares (the home
  // blocks), which can only carry the hats everyone sees. Per viewer, so never cached anywhere.
  getViewerEventDecorations: protectedProcedure
    .meta({ requiredScope: TokenScope.MediaRead })
    .input(getViewerEventDecorationsSchema)
    .use(noEdgeCache())
    // A flagged viewer's homepage asks once per block section, about a dozen times a load.
    .use(rateLimit({ limit: 120, period: CacheTTL.xs }))
    .query(({ input, ctx }) =>
      getViewerEventDecorations({ ids: input.ids, entity: input.entityType, viewer: ctx.user })
    ),
  equipContentDecoration: protectedProcedure
    .meta({ requiredScope: TokenScope.CollectionsWrite })
    .input(equipCosmeticSchema)
    .mutation(({ input, ctx }) =>
      equipCosmeticToEntity({ ...input, userId: ctx.user.id, isModerator: ctx.user.isModerator })
    ),
  unequipCosmetic: protectedProcedure
    .meta({ requiredScope: TokenScope.CollectionsWrite })
    .input(unequipCosmeticSchema)
    .mutation(({ input, ctx }) => unequipCosmetic({ ...input, userId: ctx.user.id })),
});
