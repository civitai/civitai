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
import { getClientBenignLists } from '~/server/services/blocklist.service';
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
  // Moderator benign lists, shipped to the browser because the search gates run
  // client-side against Meili and have no server hop to strip on.
  getBenignPhrases: publicProcedure
    .meta({ requiredScope: TokenScope.Full })
    .use(edgeCacheIt({ ttl: CacheTTL.hour }))
    .query(async ({ ctx }) => {
      const lists = await getClientBenignLists();
      // A fail-open result is a 200 the edge would otherwise hold for an hour, pinning empty
      // whitelists site-wide off one transient error. `ctx.cache.skip` does NOT work from
      // here: `edgeCacheIt` reads it to compute the TTL BEFORE it calls this resolver, so it
      // is only usable by something upstream of the procedure. `canCache` is read after.
      //
      // All three, not just `canCache`: with `canCache: false` the middleware skips the block
      // that assigns the TTLs, so they keep the context defaults — which for an ANONYMOUS
      // caller are 60, not 0, and `s-maxage=60` would still go out.
      if (!lists.available && ctx.cache) {
        ctx.cache.canCache = false;
        ctx.cache.edgeTTL = 0;
        ctx.cache.browserTTL = 0;
      }
      return lists;
    }),
  getDbKV: publicProcedure
    .meta({ requiredScope: TokenScope.Full })
    .input(z.object({ key: z.enum(PUBLIC_DB_KV_KEYS) }))
    .use(edgeCacheIt({ ttl: CacheTTL.sm }))
    .query(async ({ input }) => {
      return dbKV.get(input.key);
    }),
});
