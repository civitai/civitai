import { publicProcedure, router } from '~/server/trpc';
import { getLiveNow, getModerationTags } from '~/server/services/system-cache';
import { edgeCacheIt } from '~/server/middleware.trpc';
import { CacheTTL } from '~/server/common/constants';

export const systemRouter = router({
  getModeratedTags: publicProcedure.query(() => getModerationTags()),
  getLiveNow: publicProcedure.use(edgeCacheIt({ ttl: CacheTTL.xs })).query(() => getLiveNow()),
});
