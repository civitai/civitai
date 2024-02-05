import { isFlagProtected, protectedProcedure, router } from '~/server/trpc';
import { getHandler } from '../controllers/user-stripe-connect.controller';
import { getStripeConnectOnboardingLink } from '../services/user-stripe-connect.service';

export const userStripeConnectRouter = router({
  get: protectedProcedure.use(isFlagProtected('creatorsProgram')).query(getHandler),
  getOnboardinLink: protectedProcedure
    .use(isFlagProtected('creatorsProgram'))
    .query(({ ctx }) => getStripeConnectOnboardingLink({ userId: ctx.user.id })),
});
