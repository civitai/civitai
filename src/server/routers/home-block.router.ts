import { isFlagProtected, protectedProcedure, publicProcedure, router } from '~/server/trpc';
import {
  createCollectionHomeBlockHandler,
  deleteUserHomeBlockHandler,
  getHomeBlocksByIdHandler,
  getHomeBlocksHandler,
  getSystemHomeBlocksHandler,
  setHomeBlocksOrderHandler,
} from '~/server/controllers/home-block.controller';
import { edgeCacheIt } from '~/server/middleware.trpc';
import {
  getHomeBlocksInputSchema,
  getHomeBlockByIdInputSchema,
  createCollectionHomeBlockInputSchema,
  getSystemHomeBlocksInputSchema,
  setHomeBlocksOrderInput,
} from '~/server/schema/home-block.schema';
import { getByIdSchema } from '~/server/schema/base.schema';

export const homeBlockRouter = router({
  getHomeBlocks: publicProcedure
    .input(getHomeBlocksInputSchema)
    .use(isFlagProtected('alternateHome'))
    .query(getHomeBlocksHandler),
  getSystemHomeBlocks: publicProcedure
    .input(getSystemHomeBlocksInputSchema)
    .use(isFlagProtected('alternateHome'))
    .query(getSystemHomeBlocksHandler),
  getHomeBlock: publicProcedure
    .input(getHomeBlockByIdInputSchema)
    .use(isFlagProtected('alternateHome'))
    .use(edgeCacheIt())
    .query(getHomeBlocksByIdHandler),
  createCollectionHomeBlock: protectedProcedure
    .input(createCollectionHomeBlockInputSchema)
    .use(isFlagProtected('alternateHome'))
    .mutation(createCollectionHomeBlockHandler),
  setHomeBlockOrder: protectedProcedure
    .input(setHomeBlocksOrderInput)
    .use(isFlagProtected('alternateHome'))
    .mutation(setHomeBlocksOrderHandler),
  delete: protectedProcedure
    .input(getByIdSchema)
    .use(isFlagProtected('alternateHome'))
    .mutation(deleteUserHomeBlockHandler),
});
