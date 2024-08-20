import { PaymentProvider } from '@prisma/client';
import { env } from '~/env/server.mjs';
import { Context } from '~/server/createContext';
import { GetPlansSchema } from '~/server/schema/subscriptions.schema';
import { getPlans, getUserSubscription } from '~/server/services/subscriptions.service';

export const getPlansHandler = async ({ input }: { input: GetPlansSchema }) => {
  return await getPlans({
    paymentProvider:
      input.paymentProvider ?? (env.NEXT_PUBLIC_DEFAULT_PAYMENT_PROVIDER as PaymentProvider),
  });
};

export const getUserSubscriptionHandler = async ({ ctx }: { ctx: Context }) => {
  if (!ctx.user?.id || !ctx.user.subscriptionId) return null;
  return await getUserSubscription({ userId: ctx.user.id });
};
