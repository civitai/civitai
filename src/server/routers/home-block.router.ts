import {
  isFlagProtected,
  moderatorProcedure,
  protectedProcedure,
  publicProcedure,
  router,
} from '~/server/trpc';
import {
  acknowledgeFeaturedCollectionHandler,
  addCollectionToFeaturedPoolHandler,
  createCollectionHomeBlockHandler,
  deleteUserHomeBlockHandler,
  getFeaturedCollectionsPoolHandler,
  getHomeBlocksByIdHandler,
  getHomeBlocksHandler,
  getSystemHomeBlocksHandler,
  removeCollectionFromFeaturedPoolHandler,
  setHomeBlocksOrderHandler,
} from '~/server/controllers/home-block.controller';
import { applyRequestBoardDomainColor, edgeCacheIt, noEdgeCache } from '~/server/middleware.trpc';
import {
  getHomeBlocksInputSchema,
  getHomeBlockByIdInputSchema,
  createCollectionHomeBlockInputSchema,
  getSystemHomeBlocksInputSchema,
  setHomeBlocksOrderInput,
  toggleFeaturedCollectionInputSchema,
} from '~/server/schema/home-block.schema';
import { getByIdSchema } from '~/server/schema/base.schema';
import { TokenScope } from '~/shared/constants/token-scope.constants';

export const homeBlockRouter = router({
  getHomeBlocks: publicProcedure
    .meta({ requiredScope: TokenScope.UserRead })
    .input(getHomeBlocksInputSchema)
    .use(isFlagProtected('alternateHome'))
    .use(noEdgeCache({ authedOnly: true }))
    .query(getHomeBlocksHandler),
  getSystemHomeBlocks: publicProcedure
    .meta({ requiredScope: TokenScope.UserRead })
    .input(getSystemHomeBlocksInputSchema)
    .use(isFlagProtected('alternateHome'))
    .query(getSystemHomeBlocksHandler),
  getHomeBlock: publicProcedure
    .meta({ requiredScope: TokenScope.UserRead })
    .input(getHomeBlockByIdInputSchema)
    .use(applyRequestBoardDomainColor)
    .use(isFlagProtected('alternateHome'))
    .use(edgeCacheIt({ ttl: 60 }))
    .query(getHomeBlocksByIdHandler),
  createCollectionHomeBlock: protectedProcedure
    .meta({ requiredScope: TokenScope.UserWrite })
    .input(createCollectionHomeBlockInputSchema)
    .use(isFlagProtected('alternateHome'))
    .mutation(createCollectionHomeBlockHandler),
  setHomeBlockOrder: protectedProcedure
    .meta({ requiredScope: TokenScope.UserWrite })
    .input(setHomeBlocksOrderInput)
    .use(isFlagProtected('alternateHome'))
    .mutation(setHomeBlocksOrderHandler),
  delete: protectedProcedure
    .meta({ requiredScope: TokenScope.UserWrite })
    .input(getByIdSchema)
    .use(isFlagProtected('alternateHome'))
    .mutation(deleteUserHomeBlockHandler),
  getFeaturedCollectionsPool: moderatorProcedure.query(getFeaturedCollectionsPoolHandler),
  addCollectionToFeaturedPool: moderatorProcedure
    .input(toggleFeaturedCollectionInputSchema)
    .mutation(addCollectionToFeaturedPoolHandler),
  removeCollectionFromFeaturedPool: moderatorProcedure
    .input(toggleFeaturedCollectionInputSchema)
    .mutation(removeCollectionFromFeaturedPoolHandler),
  acknowledgeFeaturedCollection: moderatorProcedure
    .input(toggleFeaturedCollectionInputSchema)
    .mutation(acknowledgeFeaturedCollectionHandler),
});
