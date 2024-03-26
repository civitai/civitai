import {
  toggleHiddenSchema,
  toggleHiddenTagsSchema,
} from '~/server/schema/user-preferences.schema';
import { getAllHiddenForUser, toggleHidden } from '~/server/services/user-preferences.service';
import { protectedProcedure, publicProcedure, router } from '~/server/trpc';

export const hiddenPreferencesRouter = router({
  getHidden: publicProcedure.query(({ ctx }) => getAllHiddenForUser({ userId: ctx.user?.id })),
  toggleHidden: protectedProcedure
    .input(toggleHiddenSchema)
    .mutation(({ input, ctx }) => toggleHidden({ ...input, userId: ctx.user.id })),
});
