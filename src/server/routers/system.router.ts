import { publicProcedure, router } from '~/server/trpc';
import {
  getBrowsingSettingAddons,
  getLiveFeatureFlags,
  getLiveNow,
} from '~/server/services/system-cache';
import { edgeCacheIt } from '~/server/middleware.trpc';
import { CacheTTL } from '~/server/common/constants';
import { getModWordBlocklist, getModURLBlocklist } from '~/server/utils/moderation-utils';

export const systemRouter = router({
  getLiveNow: publicProcedure.use(edgeCacheIt({ ttl: CacheTTL.xs })).query(() => getLiveNow()),
  getBrowsingSettingAddons: publicProcedure.query(() => {
    return getBrowsingSettingAddons();
  }),
  getLiveFeatureFlags: publicProcedure.query(() => {
    return getLiveFeatureFlags();
  }),
  getModerationBlocklists: publicProcedure
    .use(edgeCacheIt({ ttl: CacheTTL.day }))
    .query(async () => {
      const [wordBlocklist, urlBlocklist] = await Promise.all([
        getModWordBlocklist(),
        getModURLBlocklist(),
      ]);
      return {
        words: wordBlocklist,
        urls: urlBlocklist,
      };
    }),
});
