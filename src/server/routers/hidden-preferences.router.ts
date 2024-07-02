import { noEdgeCache } from '~/server/middleware.trpc';
import { toggleHiddenSchema } from '~/server/schema/user-preferences.schema';
import { getAllHiddenForUser, toggleHidden } from '~/server/services/user-preferences.service';
import { protectedProcedure, publicProcedure, router } from '~/server/trpc';

export const hiddenPreferencesRouter = router({
  getHidden: publicProcedure
    // Prevents edge caching hidden preferences since they're being cache in redis already
    // NOTE: this is required because this endpoint is being forcefully cache in the browser wihout reason
    .use(noEdgeCache())
    .query(({ ctx }) => getAllHiddenForUser({ userId: ctx.user?.id })),
  toggleHidden: protectedProcedure
    .input(toggleHiddenSchema)
    .mutation(({ input, ctx }) => toggleHidden({ ...input, userId: ctx.user.id })),
});
