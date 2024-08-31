import {
  throwAuthorizationError,
  throwBadRequestError,
  throwDbError,
  throwNotFoundError,
} from '~/server/utils/errorHandling';
import { Context } from '~/server/createContext';
import {
  createBuzzPurchaseTransaction,
  createCustomer,
  processCompleteBuzzTransaction,
  purchaseBuzzWithSubscription,
  updateSubscriptionPlan,
} from '~/server/services/paddle.service';
import {
  TransactionCreateInput,
  TransactionMetadataSchema,
  TransactionWithSubscriptionCreateInput,
  UpdateSubscriptionInputSchema,
} from '~/server/schema/paddle.schema';
import { getTRPCErrorFromUnknown } from '@trpc/server';
import { RECAPTCHA_ACTIONS } from '~/server/common/constants';
import { createRecaptchaAssesment } from '~/server/recaptcha/client';
import { getPaddleSubscription, getTransactionById } from '~/server/paddle/client';
import { GetByIdStringInput } from '~/server/schema/base.schema';
import { getPlans, getUserSubscription } from '~/server/services/subscriptions.service';
import { PaymentProvider } from '@prisma/client';
import { SubscriptionProductMetadata } from '~/server/schema/subscriptions.schema';

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

    const { score, reasons } = await createRecaptchaAssesment({
      token: recaptchaToken,
      recaptchaAction: RECAPTCHA_ACTIONS.PADDLE_TRANSACTION,
    });

    if (true || (score || 0) < 0.7) {
      if (reasons.length) {
        throw throwAuthorizationError(
          `Recaptcha Failed. The following reasons were detected: ${reasons.join(', ')}`
        );
      } else {
        throw throwAuthorizationError('We could not verify the authenticity of your request.');
      }
    }

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

    const paddleSubscription = await getPaddleSubscription({
      subscriptionId: subscription.id,
    });

    if (!paddleSubscription) {
      throw throwNotFoundError('Paddle subscription not found');
    }

    const plans = await getPlans({
      includeFree: true,
      paymentProvider: PaymentProvider.Paddle,
    });

    const freePlan = plans.find((p) => {
      const meta = p.metadata as SubscriptionProductMetadata;
      return meta?.tier === 'free';
    });

    if (!freePlan || (!freePlan.defaultPriceId && !freePlan.prices.length)) {
      // Cancel through paddle as we don't have a Free plan for whatever reason.
      return {
        url: paddleSubscription.managementUrls?.cancel,
        canceled: false,
      };
    }

    await updateSubscriptionPlan({
      userId: ctx.user.id,
      priceId: freePlan.defaultPriceId ?? freePlan.prices[0].id,
    });

    return {
      url: undefined,
      canceled: true,
    };
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
      return urls;
    } catch (e) {
      // Ignore error and assume subscription was not found.
      return urls;
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
