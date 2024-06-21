import { CacheTTL } from '~/server/common/constants';
import { edgeCacheIt } from '~/server/middleware.trpc';
import { getAllTools } from '~/server/services/tool.service';
import { publicProcedure, router } from '~/server/trpc';

export const toolRouter = router({
  getAll: publicProcedure.use(edgeCacheIt({ ttl: CacheTTL.hour })).query(() => getAllTools()),
});
