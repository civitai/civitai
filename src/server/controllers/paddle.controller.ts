import {
  throwAuthorizationError,
  throwBadRequestError,
  throwDbError,
  throwNotFoundError,
} from '~/server/utils/errorHandling';
import { Context } from '~/server/createContext';
import {
  createTransaction,
  processCompleteBuzzTransaction,
  updateSubscriptionPlan,
} from '~/server/services/paddle.service';
import {
  TransactionCreateInput,
  TransactionMetadataSchema,
  UpdateSubscriptionInputSchema,
} from '~/server/schema/paddle.schema';
import { getTRPCErrorFromUnknown } from '@trpc/server';
import { RECAPTCHA_ACTIONS } from '~/server/common/constants';
import { createRecaptchaAssesment } from '~/server/recaptcha/client';
import { getPaddleSubscription, getTransactionById } from '~/server/paddle/client';
import { GetByIdStringInput } from '~/server/schema/base.schema';
import { getUserSubscription } from '~/server/services/subscriptions.service';
import { PaymentProvider } from '@prisma/client';

export const createTransactionHandler = async ({
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

    if ((score || 0) < 0.7) {
      if (reasons.length) {
        throw throwAuthorizationError(
          `Recaptcha Failed. The following reasons were detected: ${reasons.join(', ')}`
        );
      } else {
        throw throwAuthorizationError('We could not verify the authenticity of your request.');
      }
    }

    const user = { id: ctx.user.id, email: ctx.user.email as string };
    return await createTransaction({ user, ...input });
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
  const meta = transaction?.customData as TransactionMetadataSchema;

  if (meta.type !== 'buzzPurchase') {
    throw throwNotFoundError('Cannot process a non-buzz transaction');
  }

  if (meta.userId !== ctx.user.id) {
    throw throwAuthorizationError('You are not authorized to process this transaction');
  }

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

export const getSubscriptionCancelManagementUrlHandler = async ({
  ctx,
}: {
  ctx: DeepNonNullable<Context>;
}) => {
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

    return paddleSubscription.managementUrls?.cancel;
  } catch (e) {
    throw getTRPCErrorFromUnknown(e);
  }
};
