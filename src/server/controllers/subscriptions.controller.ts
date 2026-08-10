import { TRPCError } from '@trpc/server';
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

  if (input.buzzPurchase && !ctx.features.buzzMemberships)
    throw new TRPCError({ code: 'FORBIDDEN' });

  const fallbackToStripe = !paddleSupported;

  const defaultPaymentProvider = fallbackToStripe
    ? PaymentProvider.Stripe
    : (env.NEXT_PUBLIC_DEFAULT_PAYMENT_PROVIDER as PaymentProvider);

  return await getPlans({
    paymentProvider: input.paymentProvider ?? defaultPaymentProvider,
    interval: input.interval,
    buzzType: input.buzzType,
    buzzPurchase: input.buzzPurchase,
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
  // Spread rather than enumerate: this handler silently dropped `includeBuzzPurchase` when
  // it was added to the schema and the service, so Buzz memberships stayed invisible with
  // no error anywhere. `userId` last so a client-supplied one can't override the session.
  return await getUserSubscription({
    ...input,
    userId: ctx.user.id,
  });
};

export const getAllUserSubscriptionsHandler = async ({ ctx }: { ctx: Context }) => {
  if (!ctx.user?.id) return [];
  return await getAllUserSubscriptions(ctx.user.id);
};
