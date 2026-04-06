import { z } from 'zod';
import { publicProcedure, router } from '~/server/trpc';
import {
  getBrowsingSettingAddons,
  getLiveFeatureFlags,
  getLiveNow,
} from '~/server/services/system-cache';
import { edgeCacheIt } from '~/server/middleware.trpc';
import { CacheTTL } from '~/server/common/constants';
import { dbKV } from '~/server/db/db-helpers';

export const systemRouter = router({
  getLiveNow: publicProcedure.use(edgeCacheIt({ ttl: CacheTTL.xs })).query(() => getLiveNow()),
  getBrowsingSettingAddons: publicProcedure.query(() => {
    return getBrowsingSettingAddons();
  }),
  getLiveFeatureFlags: publicProcedure.query(() => {
    return getLiveFeatureFlags();
  }),
  getDbKV: publicProcedure
    .input(z.object({ key: z.string() }))
    .use(edgeCacheIt({ ttl: CacheTTL.sm }))
    .query(async ({ input }) => {
      return dbKV.get(input.key);
    }),
});
