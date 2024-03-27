import { getByIdSchema } from '~/server/schema/base.schema';
import { getPaginatedCosmeticsSchema } from '~/server/schema/cosmetic.schema';
import { getCosmeticDetail, getPaginatedCosmetics } from '~/server/services/cosmetic.service';
import { moderatorProcedure, protectedProcedure, router } from '~/server/trpc';

export const cosmeticRouter = router({
  getById: protectedProcedure.input(getByIdSchema).query(({ input }) => {
    return getCosmeticDetail(input);
  }),
  getPaged: moderatorProcedure.input(getPaginatedCosmeticsSchema).query(({ input }) => {
    return getPaginatedCosmetics(input);
  }),
});
