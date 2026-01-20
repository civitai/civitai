import { PaymentProvider } from '~/shared/utils/prisma/enums';
import { env } from '~/env/server';
import type { Context } from '~/server/createContext';
import type {
  GetPlansSchema,
  GetUserSubscriptionInput,
} from '~/server/schema/subscriptions.schema';
import {
  getPlans,
  getUserSubscription,
  getAllUserSubscriptions,
} from '~/server/services/subscriptions.service';

export const getPlansHandler = async ({ input, ctx }: { input: GetPlansSchema; ctx: Context }) => {
  const paddleSupported =
    env.NEXT_PUBLIC_DEFAULT_PAYMENT_PROVIDER === PaymentProvider.Paddle &&
    !!env.NEXT_PUBLIC_PADDLE_TOKEN &&
    !!env.PADDLE_SECRET_KEY;

  const fallbackToStripe = !paddleSupported;

  const defaultPaymentProvider = fallbackToStripe
    ? PaymentProvider.Stripe
    : (env.NEXT_PUBLIC_DEFAULT_PAYMENT_PROVIDER as PaymentProvider);

  return await getPlans({
    paymentProvider: input.paymentProvider ?? defaultPaymentProvider,
    interval: input.interval,
    buzzType: input.buzzType,
  });
};

export const getUserSubscriptionHandler = async ({
  ctx,
  input,
}: {
  ctx: Context;
  input?: Partial<GetUserSubscriptionInput>;
}) => {
  if (!ctx.user?.id) return null;
  return await getUserSubscription({
    userId: ctx.user.id,
    buzzType: input?.buzzType,
    includeBadState: input?.includeBadState,
  });
};

export const getAllUserSubscriptionsHandler = async ({ ctx }: { ctx: Context }) => {
  if (!ctx.user?.id) return [];
  return await getAllUserSubscriptions(ctx.user.id);
};
