import { isFlagProtected, protectedProcedure, publicProcedure, router } from '~/server/trpc';
import {
  createCollectionHomeBlockHandler,
  deleteUserHomeBlockHandler,
  getHomeBlocksByIdHandler,
  getHomeBlocksHandler,
  getSystemHomeBlocksHandler,
} from '~/server/controllers/home-block.controller';
import { applyUserPreferences } from '~/server/middleware.trpc';
import {
  getHomeBlocksInputSchema,
  getHomeBlockByIdInputSchema,
  createCollectionHomeBlockInputSchema,
  getSystemHomeBlocksInputSchema,
} from '~/server/schema/home-block.schema';
import { getByIdSchema } from '~/server/schema/base.schema';

export const homeBlockRouter = router({
  getHomeBlocks: publicProcedure
    .input(getHomeBlocksInputSchema)
    .use(isFlagProtected('alternateHome'))
    .use(applyUserPreferences())
    .query(getHomeBlocksHandler),
  getSystemHomeBlocks: publicProcedure
    .input(getSystemHomeBlocksInputSchema)
    .use(isFlagProtected('alternateHome'))
    .use(applyUserPreferences())
    .query(getSystemHomeBlocksHandler),
  getHomeBlock: publicProcedure
    .input(getHomeBlockByIdInputSchema)
    .use(isFlagProtected('alternateHome'))
    .use(applyUserPreferences())
    .query(getHomeBlocksByIdHandler),
  createCollectionHomeBlock: protectedProcedure
    .input(createCollectionHomeBlockInputSchema)
    .use(isFlagProtected('alternateHome'))
    .mutation(createCollectionHomeBlockHandler),
  delete: protectedProcedure
    .input(getByIdSchema)
    .use(isFlagProtected('alternateHome'))
    .mutation(deleteUserHomeBlockHandler),
});
