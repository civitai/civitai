import { isFlagProtected, protectedProcedure, publicProcedure, router } from '../trpc';
import {
  getClubEntity,
  getClubTiersInput,
  upsertClubInput,
  upsertClubTierInput,
} from '~/server/schema/club.schema';
import {
  getClubEntityHandler,
  getClubHandler,
  getClubTiersHandler,
  upsertClubHandler,
  upsertClubTierHandler,
  userContributingClubsHandler,
} from '~/server/controllers/club.controller';
import { getByIdSchema } from '~/server/schema/base.schema';

export const clubRouter = router({
  getById: publicProcedure.input(getByIdSchema).use(isFlagProtected('clubs')).query(getClubHandler),
  getClubEntity: publicProcedure
    .input(getClubEntity)
    .use(isFlagProtected('clubs'))
    .query(getClubEntityHandler),
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
});
