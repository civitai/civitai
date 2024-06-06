import { CacheTTL } from '~/server/common/constants';
import { edgeCacheIt } from '~/server/middleware.trpc';
import { getAllTechniques } from '~/server/services/technique.service';
import { publicProcedure, router } from '~/server/trpc';

export const techniqueRouter = router({
  getAll: publicProcedure.use(edgeCacheIt({ ttl: CacheTTL.hour })).query(() => getAllTechniques()),
});
