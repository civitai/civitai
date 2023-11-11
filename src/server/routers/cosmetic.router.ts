import { getByIdSchema } from '~/server/schema/base.schema';
import { getCosmeticDetail } from '~/server/services/cosmetic.service';
import { protectedProcedure, router } from '~/server/trpc';

export const cosmeticRouter = router({
  getById: protectedProcedure.input(getByIdSchema).query(({ input }) => {
    return getCosmeticDetail(input);
  }),
});
