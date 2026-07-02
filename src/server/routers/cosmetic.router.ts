import { getByIdSchema } from '~/server/schema/base.schema';
import { equipCosmeticSchema, getPaginatedCosmeticsSchema } from '~/server/schema/cosmetic.schema';
import {
  getCosmeticDetail,
  getPaginatedCosmetics,
  equipCosmeticToEntity,
  unequipCosmetic,
} from '~/server/services/cosmetic.service';
import { moderatorProcedure, protectedProcedure, router } from '~/server/trpc';
import { TokenScope } from '~/shared/constants/token-scope.constants';

export const cosmeticRouter = router({
  getById: protectedProcedure
    .meta({ requiredScope: TokenScope.CollectionsRead })
    .input(getByIdSchema)
    .query(({ input }) => {
      return getCosmeticDetail(input);
    }),
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
