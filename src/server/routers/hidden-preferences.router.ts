import {
  toggleHiddenSchema,
  toggleHiddenTagsSchema,
} from '~/server/schema/user-preferences.schema';
import { getAllHiddenForUser, toggleHidden } from '~/server/services/user-preferences.service';
import { protectedProcedure, publicProcedure, router } from '~/server/trpc';

export const hiddenPreferencesRouter = router({
  getHidden: publicProcedure
    .use(async ({ ctx, next }) => {
      // Prevents edge caching hidden preferences since they're being cache in redis already
      // NOTE: this is required because this endpoint is being forcefully cache in the browser wihout reason
      const result = await next();
      ctx.cache.edgeTTL = 0;

      return result;
    })
    .query(({ ctx }) => getAllHiddenForUser({ userId: ctx.user?.id })),
  toggleHidden: protectedProcedure
    .input(toggleHiddenSchema)
    .mutation(({ input, ctx }) => toggleHidden({ ...input, userId: ctx.user.id })),
});
