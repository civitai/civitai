import { isFlagProtected, protectedProcedure, publicProcedure, router } from '../trpc';
import {
  getClubTiersInput,
  getInfiniteClubSchema,
  getPaginatedClubResourcesSchema,
  removeClubResourceInput,
  updateClubResourceInput,
  upsertClubInput,
  upsertClubResourceInput,
  upsertClubTierInput,
} from '~/server/schema/club.schema';
import {
  deleteClubHandler,
  deleteClubTierHandler,
  getClubHandler,
  getClubResourceDetailsHandler,
  getClubTiersHandler,
  getInfiniteClubsHandler,
  getPaginatedClubResourcesHandler,
  removeClubResourceHandler,
  updateClubResourceHandler,
  upsertClubHandler,
  upsertClubResourceHandler,
  upsertClubTierHandler,
  userContributingClubsHandler,
} from '~/server/controllers/club.controller';
import { getByEntitySchema, getByIdSchema } from '~/server/schema/base.schema';

export const clubRouter = router({
  getInfinite: publicProcedure
    .input(getInfiniteClubSchema)
    .use(isFlagProtected('clubs'))
    .query(getInfiniteClubsHandler),
  getById: publicProcedure.input(getByIdSchema).use(isFlagProtected('clubs')).query(getClubHandler),
  userContributingClubs: publicProcedure
    .use(isFlagProtected('clubs'))
    .query(userContributingClubsHandler),
  upsert: protectedProcedure
    .input(upsertClubInput)
    .use(isFlagProtected('createClubs'))
    .mutation(upsertClubHandler),
  getTiers: publicProcedure
    .input(getClubTiersInput)
    .use(isFlagProtected('clubs'))
    .query(getClubTiersHandler),
  upsertTier: protectedProcedure
    .input(upsertClubTierInput)
    .use(isFlagProtected('clubs'))
    .mutation(upsertClubTierHandler),
  deleteTier: protectedProcedure
    .input(getByIdSchema)
    .use(isFlagProtected('clubs'))
    .mutation(deleteClubTierHandler),
  upsertResource: protectedProcedure
    .input(upsertClubResourceInput)
    .use(isFlagProtected('clubs'))
    .mutation(upsertClubResourceHandler),
  updateResource: protectedProcedure
    .input(updateClubResourceInput)
    .use(isFlagProtected('clubs'))
    .mutation(updateClubResourceHandler),
  removeResource: protectedProcedure
    .input(removeClubResourceInput)
    .use(isFlagProtected('clubs'))
    .mutation(removeClubResourceHandler),
  resourceDetails: publicProcedure
    .input(getByEntitySchema)
    .use(isFlagProtected('clubs'))
    .query(getClubResourceDetailsHandler),
  getPaginatedClubResources: publicProcedure
    .input(getPaginatedClubResourcesSchema)
    .use(isFlagProtected('clubs'))
    .query(getPaginatedClubResourcesHandler),
  delete: protectedProcedure
    .input(getByIdSchema)
    .use(isFlagProtected('createClubs'))
    .mutation(deleteClubHandler),
});
