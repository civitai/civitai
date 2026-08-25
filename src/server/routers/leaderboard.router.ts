import { CacheTTL } from '~/server/common/constants';
import { applyRequestBoardDomainColor, cacheIt, edgeCacheIt } from '~/server/middleware.trpc';
import type { GetLeaderboardInput } from '~/server/schema/leaderboard.schema';
import {
  getLeaderboardPositionsSchema,
  getLeaderboardSchema,
  getLeaderboardsSchema,
} from '~/server/schema/leaderboard.schema';
import {
  getLeaderboard,
  getLeaderboards,
  getLeaderboardPositions,
  getLeaderboardLegends,
} from '~/server/services/leaderboard.service';
import { middleware, publicProcedure, router } from '~/server/trpc';
import { TokenScope } from '~/shared/constants/token-scope.constants';

const leaderboardEdgeCache = edgeCacheIt({
  ttl: CacheTTL.xs,
});

/**
 * Edge-cache opt-out for the one caller shape whose response body differs.
 *
 * `getLeaderboard` (`~/server/services/leaderboard.service`) drops the
 * `AND l.public = true` predicate when `isModerator` is set, so a moderator's body can
 * contain non-public boards that no other caller's body contains. The Redis layer
 * already declares that dependency — `cacheIt`'s `varyBy` puts `isModerator` in the
 * key — but the edge cache keys on the URL alone and has nothing to vary on, so the
 * only correct move there is to not cache the moderator's response at all. This closes
 * that asymmetry.
 *
 * ONLY moderators are excluded, deliberately. An anonymous caller and an ordinary
 * authenticated non-moderator both get the `public = true` variant, so their bodies are
 * interchangeable and stay fully edge-cacheable. Do NOT "tighten" this to `ctx.user`:
 * that would throw the edge cache away for the entire logged-in population and buy
 * nothing, because their body is already the same one anonymous callers get.
 *
 * Placement is load-bearing: `.use()` this BEFORE `leaderboardEdgeCache`. `edgeCacheIt`
 * reads `ctx.cache.skip` to compute the TTL *before* it calls `next()`, so an opt-out
 * placed after it never runs in time and is inert.
 *
 * The cache object is COPIED rather than mutated in place (same shape as
 * `~/server/routers/model.router`'s `skipEdgeCache`). `ctx.cache` is request-scoped and
 * shared by every procedure resolved from the same request, so an in-place
 * `ctx.cache.skip = true` would escape this procedure. The copy also keeps
 * `edgeCacheIt`'s TTL assignments off the root context that `responseMeta`
 * (`src/pages/api/trpc/[trpc].ts`) builds the `Cache-Control` header from.
 *
 * `!ctx.cache` is passed straight through: that is the SSG/`createServerSideHelpers`
 * path, which has no HTTP response to decorate, and `edgeCacheIt` returns early on it.
 * Handing it a fabricated cache object would defeat that early return.
 */
const skipEdgeCacheForModerators = middleware(({ ctx, next }) => {
  if (!ctx.cache || !ctx.user?.isModerator) return next();

  return next({ ctx: { ...ctx, cache: { ...ctx.cache, skip: true } } });
});

// `applyRequestBoardDomainColor` must be `.use()`d BEFORE `cacheIt` on every
// procedure here: cacheIt hashes the input to build its Redis key, so a domain
// stamped after it would leave one entry shared across colors.
export const leaderboardRouter = router({
  getLeaderboards: publicProcedure
    .meta({ requiredScope: TokenScope.MediaRead })
    .input(getLeaderboardsSchema.pick({ domain: true }).default({}))
    .use(applyRequestBoardDomainColor)
    .query(({ input, ctx }) =>
      getLeaderboards({ ...input, isModerator: ctx?.user?.isModerator ?? false })
    ),
  getLeaderboardPositions: publicProcedure
    .meta({ requiredScope: TokenScope.MediaRead })
    .input(getLeaderboardPositionsSchema)
    .use(applyRequestBoardDomainColor)
    .use(
      cacheIt({
        ttl: CacheTTL.day,
        tags: () => ['leaderboard', 'leaderboard-positions'],
        varyBy: (ctx) => ({ isModerator: ctx.user?.isModerator ?? false }),
      })
    )
    .query(({ input, ctx }) =>
      getLeaderboardPositions({
        ...input,
        userId: input.userId,
        isModerator: ctx?.user?.isModerator ?? false,
      })
    ),
  getLeaderboard: publicProcedure
    .meta({ requiredScope: TokenScope.MediaRead })
    .input(getLeaderboardSchema)
    .use(applyRequestBoardDomainColor)
    .use(
      cacheIt({
        ttl: CacheTTL.day,
        tags: (input: GetLeaderboardInput) => ['leaderboard', `leaderboard-${input.id}`],
        varyBy: (ctx) => ({ isModerator: ctx.user?.isModerator ?? false }),
      })
    )
    .use(skipEdgeCacheForModerators)
    .use(leaderboardEdgeCache)
    .query(({ input, ctx }) =>
      getLeaderboard({ ...input, isModerator: ctx?.user?.isModerator ?? false })
    ),
  // NOT `skipEdgeCacheForModerators`, deliberately, even though this procedure shares
  // the `leaderboardEdgeCache` instance above. `getLeaderboardLegends` is handed an
  // `isModerator` but never reads it — its query filters on `leaderboardId` and domain
  // only, with no `public` predicate — so every caller gets byte-identical results and
  // there is nothing for the edge to vary on. That is also why its `cacheIt` carries no
  // `varyBy` while `getLeaderboard`'s does. If that query ever grows a moderator-only
  // branch, this procedure needs the opt-out (and its `cacheIt` needs a `varyBy`) too.
  getLeadboardLegends: publicProcedure
    .meta({ requiredScope: TokenScope.MediaRead })
    .input(getLeaderboardSchema)
    .use(applyRequestBoardDomainColor)
    .use(
      cacheIt({
        ttl: CacheTTL.day,
        tags: (input: GetLeaderboardInput) => [
          'leaderboard',
          `leaderboard-${input.id}`,
          `leaderboard-${input.id}-legends`,
        ],
      })
    )
    .use(leaderboardEdgeCache)
    .query(({ input, ctx }) =>
      getLeaderboardLegends({ ...input, isModerator: ctx?.user?.isModerator ?? false })
    ),
});
