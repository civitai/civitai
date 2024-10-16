import { getUserAccountHandler } from '~/server/controllers/signals.controller';
import { prodOnly } from '~/server/middleware.trpc';
import { protectedProcedure, router } from '~/server/trpc';

export const signalsRouter = router({
  getToken: protectedProcedure.use(prodOnly).query(getUserAccountHandler),
});
