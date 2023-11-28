import { isFlagProtected, protectedProcedure, publicProcedure, router } from '../trpc';
import {
  getClubTiersInput,
  getInfiniteClubPostsSchema,
  upsertClubInput,
  upsertClubResourceInput,
  upsertClubTierInput,
} from '~/server/schema/club.schema';
import {
  getClubHandler,
  getClubResourceDetailsHandler,
  getClubTiersHandler,
  getInfiniteClubPostsHandler,
  upsertClubHandler,
  upsertClubResourceHandler,
  upsertClubTierHandler,
  userContributingClubsHandler,
} from '~/server/controllers/club.controller';
import { getByEntitySchema, getByIdSchema } from '~/server/schema/base.schema';
import { getInfiniteBountySchema } from '~/server/schema/bounty.schema';
import { getInfiniteBountiesHandler } from '~/server/controllers/bounty.controller';

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
  resourceDetails: publicProcedure
    .input(getByEntitySchema)
    .use(isFlagProtected('clubs'))
    .query(getClubResourceDetailsHandler),
  getInfinitePosts: publicProcedure
    .input(getInfiniteClubPostsSchema)
    .use(isFlagProtected('clubs'))
    .query(getInfiniteClubPostsHandler),
});
