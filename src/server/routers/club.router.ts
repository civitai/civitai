import { isFlagProtected, protectedProcedure, publicProcedure, router } from '../trpc';
import {
  getClubTiersInput,
  upsertClubInput,
  upsertClubResourceInput,
  upsertClubTierInput,
} from '~/server/schema/club.schema';
import {
  getClubHandler,
  getClubTiersHandler,
  upsertClubHandler,
  upsertClubResourceHandler,
  upsertClubTierHandler,
  userContributingClubsHandler,
} from '~/server/controllers/club.controller';
import { getByIdSchema } from '~/server/schema/base.schema';

export const clubRouter = router({
  getById: publicProcedure.input(getByIdSchema).use(isFlagProtected('clubs')).query(getClubHandler),
  userContributingClubs: publicProcedure
    .use(isFlagProtected('clubs'))
    .query(userContributingClubsHandler),
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
  upsertResource: protectedProcedure
    .input(upsertClubResourceInput)
    .use(isFlagProtected('clubs'))
    .mutation(upsertClubResourceHandler),
});
