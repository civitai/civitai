import { getByIdSchema } from '~/server/schema/base.schema';
import {
  equipCosmeticSchema,
  getStickerCosmeticsSchema,
  getPaginatedCosmeticsSchema,
} from '~/server/schema/cosmetic.schema';
import {
  getCosmeticDetail,
  getStickerCosmetics,
  getPaginatedCosmetics,
  equipCosmeticToEntity,
  unequipCosmetic,
} from '~/server/services/cosmetic.service';
import { getStickerBalances } from '~/server/services/sticker.service';
import { moderatorProcedure, protectedProcedure, publicProcedure, router } from '~/server/trpc';
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
  getPaged: moderatorProcedure.input(getPaginatedCosmeticsSchema).query(({ input }) => {
    return getPaginatedCosmetics(input);
  }),
  equipContentDecoration: protectedProcedure
    .meta({ requiredScope: TokenScope.CollectionsWrite })
    .input(equipCosmeticSchema)
    .mutation(({ input, ctx }) => equipCosmeticToEntity({ ...input, userId: ctx.user.id })),
  unequipCosmetic: protectedProcedure
    .meta({ requiredScope: TokenScope.CollectionsWrite })
    .input(equipCosmeticSchema)
    .mutation(({ input, ctx }) => unequipCosmetic({ ...input, userId: ctx.user.id })),
});
