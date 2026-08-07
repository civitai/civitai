import { getByIdSchema } from '~/server/schema/base.schema';
import {
  equipCosmeticSchema,
  getStickerCosmeticsSchema,
  getPaginatedCosmeticsSchema,
  grantCosmeticsToUsersSchema,
  purchaseStickerUsesSchema,
} from '~/server/schema/cosmetic.schema';
import {
  getCosmeticDetail,
  getStickerCosmetics,
  getPaginatedCosmetics,
  equipCosmeticToEntity,
  grantCosmeticsToUsers,
  revokeCosmeticsFromUsers,
  unequipCosmetic,
} from '~/server/services/cosmetic.service';
import { getStickerBalances, purchaseStickerUses } from '~/server/services/sticker.service';
import { getAllowedAccountTypes } from '~/server/utils/buzz-helpers';
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
  // Remaining uses per owned sticker, so the picker can show a balance instead
  // of the user discovering it as a failed comment submit.
  getStickerBalances: protectedProcedure
    .meta({ requiredScope: TokenScope.CollectionsRead })
    .query(({ ctx }) => getStickerBalances(ctx.user.id)),
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
  grantToUsers: moderatorProcedure
    .input(grantCosmeticsToUsersSchema)
    .mutation(({ input }) => grantCosmeticsToUsers(input)),
  revokeFromUsers: moderatorProcedure
    .input(grantCosmeticsToUsersSchema)
    .mutation(({ input }) => revokeCosmeticsFromUsers(input)),
  equipContentDecoration: protectedProcedure
    .meta({ requiredScope: TokenScope.CollectionsWrite })
    .input(equipCosmeticSchema)
    .mutation(({ input, ctx }) => equipCosmeticToEntity({ ...input, userId: ctx.user.id })),
  unequipCosmetic: protectedProcedure
    .meta({ requiredScope: TokenScope.CollectionsWrite })
    .input(equipCosmeticSchema)
    .mutation(({ input, ctx }) => unequipCosmetic({ ...input, userId: ctx.user.id })),
});
