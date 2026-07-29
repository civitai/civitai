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
import { TokenScope } from '~/shared/constants/token-scope.constants';

/**
 * `KeyValue` is a general-purpose store: alongside job cursors it holds OAuth codes, scoring
 * multipliers and other operational config. This procedure is unauthenticated, so it may only
 * ever serve keys that are already public through a dedicated endpoint of their own —
 * `modelFileOptions` via `modelFile.getOptions`, `training-announcement-2` via
 * `training.getStatus`. Anything else needs its own procedure with its own gate.
 */
const PUBLIC_DB_KV_KEYS = ['modelFileOptions', 'training-announcement-2'] as const;

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
    .input(z.object({ key: z.enum(PUBLIC_DB_KV_KEYS) }))
    .use(edgeCacheIt({ ttl: CacheTTL.sm }))
    .query(async ({ input }) => {
      return dbKV.get(input.key);
    }),
});
