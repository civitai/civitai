import { isFlagProtected, protectedProcedure, publicProcedure, router } from '../trpc';
import {
  getClubTiersInput,
  upsertClubInput,
  upsertClubTierInput,
} from '~/server/schema/club.schema';
import {
  getClubHandler,
  getClubTiersHandler,
  upsertClubHandler,
  upsertClubTierHandler,
} from '~/server/controllers/club.controller';
import { getByIdSchema } from '~/server/schema/base.schema';

export const clubRouter = router({
  getById: publicProcedure.input(getByIdSchema).use(isFlagProtected('clubs')).query(getClubHandler),
  upsert: protectedProcedure
    .input(upsertClubInput)
    .use(isFlagProtected('clubs'))
    .mutation(upsertClubHandler),
  getTiers: publicProcedure
    .input(getClubTiersInput)
    .use(isFlagProtected('clubs'))
    .query(getClubTiersHandler),
  upsertTier: protectedProcedure
    .input(upsertClubTierInput)
    .use(isFlagProtected('clubs'))
    .mutation(upsertClubTierHandler),
});
