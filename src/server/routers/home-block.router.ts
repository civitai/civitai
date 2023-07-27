import { isFlagProtected, publicProcedure, router } from '~/server/trpc';
import {
  getHomeBlocksByIdHandler,
  getHomeBlocksHandler,
} from '~/server/controllers/home-block.controller';
import { applyUserPreferences } from '~/server/middleware.trpc';
import {
  getHomeBlocksInputSchema,
  getHomeBlockByIdInputSchema,
} from '~/server/schema/home-block.schema';

export const homeBlockRouter = router({
  getHomeBlocks: publicProcedure
    .input(getHomeBlocksInputSchema)
    .use(isFlagProtected('alternateHome'))
    .use(applyUserPreferences())
    .query(getHomeBlocksHandler),
  getHomeBlock: publicProcedure
    .input(getHomeBlockByIdInputSchema)
    .use(isFlagProtected('alternateHome'))
    .use(applyUserPreferences())
    .query(getHomeBlocksByIdHandler),
});
