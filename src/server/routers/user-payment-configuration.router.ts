import { isFlagProtected, protectedProcedure, router } from '~/server/trpc';
import { getHandler } from '../controllers/user-payment-configuration.controller';
import {
  getStripeConnectOnboardingLink,
  getTipaltiDashboardUrl,
} from '../services/user-payment-configuration.service';
import { getTipaltiDashbordUrlSchema } from '~/server/schema/user-payment-configuration.schema';

export const userPaymentConfigurationRouter = router({
  get: protectedProcedure.query(getHandler),
  getOnboardinLink: protectedProcedure.query(({ ctx }) =>
    getStripeConnectOnboardingLink({ userId: ctx.user.id })
  ),

  getTipaltiDashboardUrl: protectedProcedure
    .input(getTipaltiDashbordUrlSchema)
    .query(({ ctx, input }) =>
      getTipaltiDashboardUrl({ userId: ctx.user.id, type: input.type ?? 'setup' })
    ),
});
