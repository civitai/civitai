import { isFlagProtected, protectedProcedure, router } from '~/server/trpc';
import { getHandler } from '../controllers/user-payment-configuration.controller';
import {
  getStripeConnectOnboardingLink,
  getTipaltiOnboardingUrl,
} from '../services/user-payment-configuration.service';

export const userPaymentConfigurationRouter = router({
  get: protectedProcedure.use(isFlagProtected('creatorsProgram')).query(getHandler),
  getOnboardinLink: protectedProcedure
    .use(isFlagProtected('creatorsProgram'))
    .query(({ ctx }) => getStripeConnectOnboardingLink({ userId: ctx.user.id })),

  getTipaltiOnboardingUrl: protectedProcedure
    .use(isFlagProtected('creatorsProgram'))
    .query(({ ctx }) => getTipaltiOnboardingUrl({ userId: ctx.user.id })),
});
