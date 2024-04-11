import { getByIdSchema } from '~/server/schema/base.schema';
import { equipCosmeticSchema, getPaginatedCosmeticsSchema } from '~/server/schema/cosmetic.schema';
import {
  getCosmeticDetail,
  getPaginatedCosmetics,
  equipCosmeticToEntity,
  unequipCosmetic,
} from '~/server/services/cosmetic.service';
import { moderatorProcedure, protectedProcedure, router } from '~/server/trpc';

export const cosmeticRouter = router({
  getById: protectedProcedure.input(getByIdSchema).query(({ input }) => {
    return getCosmeticDetail(input);
  }),
  getPaged: moderatorProcedure.input(getPaginatedCosmeticsSchema).query(({ input }) => {
    return getPaginatedCosmetics(input);
  }),
  equipContentDecoration: protectedProcedure
    .input(equipCosmeticSchema)
    .mutation(({ input, ctx }) => equipCosmeticToEntity({ ...input, userId: ctx.user.id })),
  unequipCosmetic: protectedProcedure
    .input(equipCosmeticSchema)
    .mutation(({ input, ctx }) => unequipCosmetic({ ...input, userId: ctx.user.id })),
});
