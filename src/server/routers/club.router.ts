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
import { TokenScope } from '~/shared/constants/token-scope.constants';

export const clubRouter = router({
  getInfinite: publicProcedure
    .meta({ requiredScope: TokenScope.CollectionsRead })
    .input(getInfiniteClubSchema)
    .use(isFlagProtected('clubs'))
    .query(getInfiniteClubsHandler),
  getById: publicProcedure
    .meta({ requiredScope: TokenScope.CollectionsRead })
    .input(getByIdSchema)
    .use(isFlagProtected('clubs'))
    .query(getClubHandler),
  userContributingClubs: publicProcedure
    .meta({ requiredScope: TokenScope.CollectionsRead })
    .use(isFlagProtected('clubs'))
    .query(userContributingClubsHandler),
  upsert: protectedProcedure
    .meta({ requiredScope: TokenScope.CollectionsWrite })
    .input(upsertClubInput)
    .use(isFlagProtected('createClubs'))
    .mutation(upsertClubHandler),
  getTiers: publicProcedure
    .meta({ requiredScope: TokenScope.CollectionsRead })
    .input(getClubTiersInput)
    .use(isFlagProtected('clubs'))
    .query(getClubTiersHandler),
  upsertTier: protectedProcedure
    .meta({ requiredScope: TokenScope.CollectionsWrite })
    .input(upsertClubTierInput)
    .use(isFlagProtected('clubs'))
    .mutation(upsertClubTierHandler),
  deleteTier: protectedProcedure
    .meta({ requiredScope: TokenScope.CollectionsWrite })
    .input(getByIdSchema)
    .use(isFlagProtected('clubs'))
    .mutation(deleteClubTierHandler),
  upsertResource: protectedProcedure
    .meta({ requiredScope: TokenScope.CollectionsWrite })
    .input(upsertClubResourceInput)
    .use(isFlagProtected('clubs'))
    .mutation(upsertClubResourceHandler),
  updateResource: protectedProcedure
    .meta({ requiredScope: TokenScope.CollectionsWrite })
    .input(updateClubResourceInput)
    .use(isFlagProtected('clubs'))
    .mutation(updateClubResourceHandler),
  removeResource: protectedProcedure
    .meta({ requiredScope: TokenScope.CollectionsWrite })
    .input(removeClubResourceInput)
    .use(isFlagProtected('clubs'))
    .mutation(removeClubResourceHandler),
  resourceDetails: publicProcedure
    .meta({ requiredScope: TokenScope.CollectionsRead })
    .input(getByEntitySchema)
    .use(isFlagProtected('clubs'))
    .query(getClubResourceDetailsHandler),
  getPaginatedClubResources: publicProcedure
    .meta({ requiredScope: TokenScope.CollectionsRead })
    .input(getPaginatedClubResourcesSchema)
    .use(isFlagProtected('clubs'))
    .query(getPaginatedClubResourcesHandler),
  delete: protectedProcedure
    .meta({ requiredScope: TokenScope.CollectionsWrite })
    .input(getByIdSchema)
    .use(isFlagProtected('createClubs'))
    .mutation(deleteClubHandler),
});
