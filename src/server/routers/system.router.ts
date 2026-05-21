import { z } from 'zod';
import { publicProcedure, router } from '~/server/trpc';
import {
  getBrowsingSettingAddons,
  getCreationBlockedTags,
  getLiveFeatureFlags,
  getLiveNow,
} from '~/server/services/system-cache';
import { edgeCacheIt } from '~/server/middleware.trpc';
import { CacheTTL } from '~/server/common/constants';
import { dbKV } from '~/server/db/db-helpers';
import { loadProfanityList } from '~/libs/profanity-simple/list-loader';
import { TokenScope } from '~/shared/constants/token-scope.constants';

export const systemRouter = router({
  getLiveNow: publicProcedure
    .meta({ requiredScope: TokenScope.Full })
    .use(edgeCacheIt({ ttl: CacheTTL.xs }))
    .query(() => getLiveNow()),
  getBrowsingSettingAddons: publicProcedure.meta({ requiredScope: TokenScope.Full }).query(() => {
    return getBrowsingSettingAddons();
  }),
  getLiveFeatureFlags: publicProcedure.meta({ requiredScope: TokenScope.Full }).query(() => {
    return getLiveFeatureFlags();
  }),
  getCreationBlockedTags: publicProcedure
    .meta({ requiredScope: TokenScope.Full })
    .use(edgeCacheIt({ ttl: CacheTTL.hour }))
    .query(() => getCreationBlockedTags()),
  getDbKV: publicProcedure
    .meta({ requiredScope: TokenScope.Full })
    .input(z.object({ key: z.string() }))
    .use(edgeCacheIt({ ttl: CacheTTL.sm }))
    .query(async ({ input }) => {
      return dbKV.get(input.key);
    }),
  getProfanityLists: publicProcedure
    .meta({ requiredScope: TokenScope.Full })
    .use(edgeCacheIt({ ttl: CacheTTL.sm }))
    .query(async () => {
      const [display, search] = await Promise.all([
        loadProfanityList('display'),
        loadProfanityList('search'),
      ]);
      return { display, search };
    }),
});
