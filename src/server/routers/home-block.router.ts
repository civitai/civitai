import { isFlagProtected, publicProcedure, router } from '~/server/trpc';
import { getHomeBlocksHandler } from '~/server/controllers/home-block.controller';
import { applyUserPreferences } from '~/server/middleware.trpc';
import { getHomeBlocksInputSchema } from '~/server/schema/home-block.schema';

export const homeBlockRouter = router({
  getHomeBlocks: publicProcedure
    .input(getHomeBlocksInputSchema)
    .use(isFlagProtected('alternateHome'))
    .use(applyUserPreferences())
    .query(getHomeBlocksHandler),
});
