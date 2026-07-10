import { noEdgeCache } from '~/server/middleware.trpc';
import { toggleHiddenSchema } from '~/server/schema/user-preferences.schema';
import { getAllHiddenForUser, toggleHidden } from '~/server/services/user-preferences.service';
import { protectedProcedure, publicProcedure, router } from '~/server/trpc';
import { TokenScope } from '~/shared/constants/token-scope.constants';

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
  toggleHidden: protectedProcedure
    .meta({ requiredScope: TokenScope.UserWrite })
    .input(toggleHiddenSchema)
    .mutation(({ input, ctx }) => toggleHidden({ ...input, userId: ctx.user.id })),
});
