import { publicProcedure, router } from '~/server/trpc';
import { getLiveNow } from '~/server/services/system-cache';
import { edgeCacheIt } from '~/server/middleware.trpc';
import { CacheTTL } from '~/server/common/constants';

export const systemRouter = router({
  getLiveNow: publicProcedure.use(edgeCacheIt({ ttl: CacheTTL.xs })).query(() => getLiveNow()),
});
