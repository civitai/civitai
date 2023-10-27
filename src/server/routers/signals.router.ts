import { getUserAccountHandler } from '~/server/controllers/signals.controller';
import { protectedProcedure, router } from '~/server/trpc';

export const signalsRouter = router({
  getAccessToken: protectedProcedure.query(getUserAccountHandler),
});
