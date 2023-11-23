import { isFlagProtected, protectedProcedure, publicProcedure, router } from '../trpc';
import { upsertClubInput } from '~/server/schema/club.schema';
import { getClubHandler, upsertClubHandler } from '~/server/controllers/club.controller';
import { getByIdSchema } from '~/server/schema/base.schema';

export const clubRouter = router({
  getById: publicProcedure.input(getByIdSchema).query(getClubHandler),
  upsert: protectedProcedure
    .input(upsertClubInput)
    .use(isFlagProtected('clubs'))
    .mutation(upsertClubHandler),
});
