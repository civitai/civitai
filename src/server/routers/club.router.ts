import { isFlagProtected, protectedProcedure, router } from '../trpc';
import { upsertClubInput } from '~/server/schema/club.schema';
import { upsertClubHandler } from '~/server/controllers/club.controller';

export const clubRouter = router({
  upsert: protectedProcedure
    .input(upsertClubInput)
    .use(isFlagProtected('clubs'))
    .mutation(upsertClubHandler),
});
