import { CacheTTL } from '~/server/common/constants';
import { noEdgeCache, rateLimit } from '~/server/middleware.trpc';
import type { ToggleHiddenSchemaOutput } from '~/server/schema/user-preferences.schema';
import {
  clearHiddenSchema,
  getHiddenImagesForUserSchema,
  getHiddenModelsSchema,
  toggleHiddenSchema,
} from '~/server/schema/user-preferences.schema';
import {
  clearHidden,
  getAllHiddenForUser,
  getHiddenImagesForUser,
  getHiddenModelsForUser,
  toggleHidden,
} from '~/server/services/user-preferences.service';
import { protectedProcedure, publicProcedure, router } from '~/server/trpc';
import { TokenScope } from '~/shared/constants/token-scope.constants';

const blockUserErrorMessage = "You're blocking users too quickly. Please try again later.";

// Only block attempts count; unblocks and the other hidden kinds are unmetered.
// `rateLimit` refuses once PRIOR attempts exceed `limit`, so 9/49 allow 10/min and 50/day.
const blockUserRateLimit = rateLimit<ToggleHiddenSchemaOutput>(
  [
    { limit: 9, period: CacheTTL.xs, errorMessage: blockUserErrorMessage },
    { limit: 49, period: CacheTTL.day, errorMessage: blockUserErrorMessage },
  ],
  (input) => input.kind === 'blockedUser' && input.hidden !== false,
  { sharedKey: 'block-user' }
);

export const hiddenPreferencesRouter = router({
  getHidden: publicProcedure
    .meta({ requiredScope: TokenScope.UserRead })
    // Prevents edge caching hidden preferences since they're being cache in redis already
    // NOTE: this is required because this endpoint is being forcefully cache in the browser wihout reason
    .use(noEdgeCache())
    // `hiddenPrefsCompact` (Flipt-ramped) → emit the compact wire shape, which
    // strips the pure-overhead object wrapping on the id-only sets so superjson
    // doesn't freeze the event loop re-serializing a whale's entire hidden set
    // on every response (incl. cache hits). The client re-expands to the legacy
    // shape, so downstream data is identical. See `~/shared/hidden-preferences/compact`.
    .query(({ ctx }) =>
      getAllHiddenForUser({ userId: ctx.user?.id, compact: !!ctx.features?.hiddenPrefsCompact })
    ),
  // Per-viewer by definition, so it must never be edge-cached.
  getHiddenImagesForUser: protectedProcedure
    .meta({ requiredScope: TokenScope.UserRead })
    .use(noEdgeCache())
    .input(getHiddenImagesForUserSchema)
    .query(({ input, ctx }) =>
      getHiddenImagesForUser({ userId: ctx.user.id, targetUserId: input.userId })
    ),
  toggleHidden: protectedProcedure
    .meta({ requiredScope: TokenScope.UserWrite })
    .input(toggleHiddenSchema)
    .use(blockUserRateLimit)
    .mutation(({ input, ctx }) => toggleHidden({ ...input, userId: ctx.user.id })),
  getHiddenModels: protectedProcedure
    .meta({ requiredScope: TokenScope.UserRead })
    .use(noEdgeCache())
    .input(getHiddenModelsSchema)
    // A name search reads every one of the user's Hide rows; whales run ~1.7s per request.
    .use(rateLimit({ limit: 30, period: CacheTTL.xs }, (input) => !!input.query))
    .query(({ input, ctx }) => getHiddenModelsForUser({ ...input, userId: ctx.user.id })),
  clearHidden: protectedProcedure
    .meta({ requiredScope: TokenScope.UserWrite })
    .input(clearHiddenSchema)
    .mutation(({ input, ctx }) => clearHidden({ ...input, userId: ctx.user.id })),
});
