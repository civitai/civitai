import { getUserAccountHandler } from '~/server/controllers/signals.controller';
import { isFlagProtected, protectedProcedure, router } from '~/server/trpc';

export const signalsRouter = router({
  getToken: protectedProcedure.use(isFlagProtected('signal')).query(getUserAccountHandler),
});
