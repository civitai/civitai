import { getTRPCErrorFromUnknown } from '@trpc/server';
import type { Context } from '~/server/createContext';
import {
  getPaddleCustomerSubscriptions,
  getPaddleSubscription,
  getTransactionById,
} from '~/server/paddle/client';
import { verifyCaptchaToken } from '~/server/recaptcha/client';
import type { GetByIdStringInput } from '~/server/schema/base.schema';
import type {
  GetPaddleAdjustmentsSchema,
  TransactionCreateInput,
  TransactionWithSubscriptionCreateInput,
  UpdateSubscriptionInputSchema,
} from '~/server/schema/paddle.schema';
import type { SubscriptionProductMetadata } from '~/server/schema/subscriptions.schema';
import {
  cancelSubscriptionPlan,
  createBuzzPurchaseTransaction,
  createCustomer,
  getAdjustmentsInfinite,
  processCompleteBuzzTransaction,
  purchaseBuzzWithSubscription,
  refreshSubscription,
  updateSubscriptionPlan,
} from '~/server/services/paddle.service';
import { getPlans, getUserSubscription } from '~/server/services/subscriptions.service';
import {
  throwAuthorizationError,
  throwBadRequestError,
  throwNotFoundError,
} from '~/server/utils/errorHandling';
import { PaymentProvider } from '~/shared/utils/prisma/enums';

export const createBuzzPurchaseTransactionHandler = async ({
  ctx,
  input,
}: {
  ctx: DeepNonNullable<Context>;
  input: TransactionCreateInput;
}) => {
  try {
    if (!ctx.user.email) {
      throw throwAuthorizationError('Email is required to create a transaction');
    }

    const { recaptchaToken } = input;
    if (!recaptchaToken) throw throwAuthorizationError('recaptchaToken required');

    const validCaptcha = await verifyCaptchaToken({ token: recaptchaToken, ip: ctx.ip });
    if (!validCaptcha) throw throwAuthorizationError('Captcha Failed. Please try again.');

    const user = { id: ctx.user.id, email: ctx.user.email as string };
    return await createBuzzPurchaseTransaction({ user, ...input });
  } catch (e) {
    throw getTRPCErrorFromUnknown(e);
  }
};

export const processCompleteBuzzTransactionHandler = async ({
  ctx,
  input,
}: {
  ctx: DeepNonNullable<Context>;
  input: GetByIdStringInput;
}) => {
  // Get the transaction:
  const transaction = await getTransactionById(input.id);
  // Process the transaction
  await processCompleteBuzzTransaction(transaction);
};

export const updateSubscriptionPlanHandler = async ({
  ctx,
  input,
}: {
  ctx: DeepNonNullable<Context>;
  input: UpdateSubscriptionInputSchema;
}) => {
  try {
    await updateSubscriptionPlan({
      ...input,
      userId: ctx.user.id,
    });
  } catch (e) {
    throw getTRPCErrorFromUnknown(e);
  }
};

export const cancelSubscriptionHandler = async ({ ctx }: { ctx: DeepNonNullable<Context> }) => {
  try {
    const subscription = await getUserSubscription({ userId: ctx.user.id });
    if (!subscription) {
      throw throwNotFoundError('Subscription not found');
    }

    if (subscription.product.provider !== PaymentProvider.Paddle) {
      throw throwBadRequestError('Current subscription is not managed by Paddle');
    }

    return await cancelSubscriptionPlan({
      userId: ctx.user.id,
    });
  } catch (e) {
    throw getTRPCErrorFromUnknown(e);
  }
};

export const getManagementUrlsHandler = async ({ ctx }: { ctx: DeepNonNullable<Context> }) => {
  try {
    const urls: {
      updatePaymentMethod: string | null | undefined;
      freeSubscriptionPriceId: string | null | undefined;
    } = {
      updatePaymentMethod: null,
      freeSubscriptionPriceId: null,
    };

    const plans = await getPlans({
      includeFree: true,
      paymentProvider: PaymentProvider.Paddle,
    });

    const freePlan = plans.find((p) => {
      const meta = p.metadata as SubscriptionProductMetadata;
      return meta?.tier === 'free';
    });

    if (freePlan && freePlan.prices.length) {
      urls.freeSubscriptionPriceId = freePlan.prices[0].id;
    }

    try {
      const subscription = await getUserSubscription({ userId: ctx.user.id });
      if (!subscription) {
        return urls;
      }

      if (subscription.product.provider !== PaymentProvider.Paddle) {
        return urls;
      }

      const paddleSubscription = await getPaddleSubscription({
        subscriptionId: subscription.id,
      });

      if (!paddleSubscription) {
        return urls;
      }

      urls.updatePaymentMethod = paddleSubscription.managementUrls?.updatePaymentMethod;
      // Cancel through paddle as we don't have a Free plan for whatever reason.
      return {
        ...urls,
        freeSubscriptionPriceId: null,
      };
    } catch (e) {
      // This might be due to subscription not found, but if the user has an active on the DB and not on paddle
      // it might mess a few things up. Better return null.
      return {
        updatePaymentMethod: null,
        freeSubscriptionPriceId: null,
      };
    }
  } catch (e) {
    throw getTRPCErrorFromUnknown(e);
  }
};

export const purchaseBuzzWithSubscriptionHandler = async ({
  ctx,
  input,
}: {
  ctx: DeepNonNullable<Context>;
  input: TransactionWithSubscriptionCreateInput;
}) => {
  try {
    return await purchaseBuzzWithSubscription({
      userId: ctx.user.id,
      ...input,
    });
  } catch (e) {
    throw getTRPCErrorFromUnknown(e);
  }
};

export const getOrCreateCustomerHandler = async ({ ctx }: { ctx: DeepNonNullable<Context> }) => {
  try {
    const user = { id: ctx.user.id, email: ctx.user.email as string };
    const customer = await createCustomer(user);
    return customer;
  } catch (e) {
    throw getTRPCErrorFromUnknown(e);
  }
};

export const refreshSubscriptionHandler = async ({ ctx }: { ctx: DeepNonNullable<Context> }) => {
  try {
    return await refreshSubscription({ userId: ctx.user.id });
  } catch (e) {
    throw getTRPCErrorFromUnknown(e);
  }
};

export const hasPaddleSubscriptionHandler = async ({ ctx }: { ctx: DeepNonNullable<Context> }) => {
  try {
    const user = { id: ctx.user.id, email: ctx.user.email as string };
    const customerId = await createCustomer(user);

    const subscriptions = await getPaddleCustomerSubscriptions({
      customerId,
    });

    const plans = await getPlans({
      includeFree: true,
      paymentProvider: PaymentProvider.Paddle,
    });

    const freePlan = plans.find((p) => {
      const meta = p.metadata as SubscriptionProductMetadata;
      return meta?.tier === 'free';
    });

    const nonFreeSubscriptions = subscriptions.filter(
      (s) => !freePlan || s.items[0]?.price?.productId !== freePlan.id
    );

    return nonFreeSubscriptions.length > 0;
  } catch (e) {
    throw getTRPCErrorFromUnknown(e);
  }
};

export const getAdjustmentsInfiniteHandler = async ({
  ctx,
  input,
}: {
  ctx: DeepNonNullable<Context>;
  input: GetPaddleAdjustmentsSchema;
}) => {
  if (!ctx.user.isModerator || !ctx.features.paddleAdjustments) {
    throwAuthorizationError('You are not authorized to view this resource');
  }

  return getAdjustmentsInfinite(input);
};
