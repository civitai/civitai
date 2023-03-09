import {
  getPreferencesHandler,
  updatePreferencesHandler,
} from '~/server/controllers/moderation.controller';
import { updatePreferencesSchema } from '~/server/schema/moderation.schema';
import { protectedProcedure, router } from '~/server/trpc';

export const moderationRouter = router({
  getPreferences: protectedProcedure.query(getPreferencesHandler),
  updatePreferences: protectedProcedure
    .input(updatePreferencesSchema)
    .mutation(updatePreferencesHandler),
});
