import { isFlagProtected, protectedProcedure, router } from '~/server/trpc';
import { getHandler } from '../controllers/user-payment-configuration.controller';
import { getStripeConnectOnboardingLink } from '../services/user-payment-configuration.service';

export const userPaymentConfigurationRouter = router({
  get: protectedProcedure.use(isFlagProtected('creatorsProgram')).query(getHandler),
  getOnboardinLink: protectedProcedure
    .use(isFlagProtected('creatorsProgram'))
    .query(({ ctx }) => getStripeConnectOnboardingLink({ userId: ctx.user.id })),
});
