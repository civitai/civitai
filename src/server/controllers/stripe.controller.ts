import {
  throwAuthorizationError,
  throwDbError,
  throwNotFoundError,
} from '~/server/utils/errorHandling';
import {
  createCustomer,
  createSubscribeSession,
  createManageSubscriptionSession,
  createDonateSession,
  getBuzzPackages,
  createBuzzSession,
  getPaymentIntent,
  getSetupIntent,
  createCancelSubscriptionSession,
  cancelSubscriptionWithFallback,
} from './../services/stripe.service';
import type { ProtectedContext } from '~/server/createContext';
import type * as Schema from '../schema/stripe.schema';

import { getTRPCErrorFromUnknown } from '@trpc/server';
import { createRecaptchaAssesment, verifyCaptchaToken } from '../recaptcha/client';
import { RECAPTCHA_ACTIONS } from '../common/constants';

export const createCustomerHandler = async ({
  input,
  ctx,
}: {
  input: Schema.CreateCustomerInput;
  ctx: ProtectedContext;
}) => {
  return await createCustomer({ ...input });
};

export const createDonateSessionHandler = async ({
  input: { returnUrl },
  ctx,
}: {
  input: Schema.CreateDonateSessionInput;
  ctx: ProtectedContext;
}) => {
  const { id, email, customerId } = ctx.user;
  if (!email) throw throwAuthorizationError('email required');
  const result = await createDonateSession({
    returnUrl,
    customerId,
    user: { id, email },
  });

  await ctx.track.userActivity({
    type: 'Donate',
    targetUserId: id,
  });

  return result;
};

export const createSubscriptionSessionHandler = async ({
  input: { priceId, refCode, blockAttribution },
  ctx,
}: {
  input: Schema.CreateSubscribeSessionInput;
  ctx: ProtectedContext;
}) => {
  const { id, email, customerId } = ctx.user;
  if (!email) throw throwAuthorizationError('email required');
  const result = await createSubscribeSession({
    priceId,
    refCode,
    // FIN-1 re-derivation happens inside createSubscribeSession, which has
    // the authenticated buyer id. The client value is untrusted.
    blockAttribution,
    customerId,
    user: { id, email },
  });

  await ctx.track.userActivity({
    type: 'Subscribe',
    targetUserId: id,
  });

  return result;
};

export const createManageSubscriptionSessionHandler = async ({
  ctx,
}: {
  ctx: ProtectedContext;
}) => {
  if (!ctx.user.customerId) throw throwNotFoundError('customerId not found');
  return await createManageSubscriptionSession({ customerId: ctx.user.customerId });
};

export const getBuzzPackagesHandler = async () => {
  try {
    const packages = await getBuzzPackages();

    return packages;
  } catch (error) {
    throw throwDbError(error);
  }
};

export const createBuzzSessionHandler = async ({
  input,
  ctx,
}: {
  input: Schema.CreateBuzzSessionInput;
  ctx: ProtectedContext;
}) => {
  try {
    const { id, email, customerId } = ctx.user;
    if (!email) throw throwAuthorizationError('email required');

    const result = await createBuzzSession({
      ...input,
      customerId,
      user: { id, email },
    });

    // await ctx.track.userActivity({
    //   type: 'Buy',
    //   targetUserId: id,
    // });

    return result;
  } catch (error) {
    throw getTRPCErrorFromUnknown(error);
  }
};

export const getPaymentIntentHandler = async ({
  input,
  ctx,
}: {
  input: Schema.PaymentIntentCreationSchema;
  ctx: ProtectedContext;
}) => {
  try {
    const { id, email, customerId } = ctx.user;

    if (!email) throw throwAuthorizationError('email required');

    const { recaptchaToken } = input;

    if (!recaptchaToken) throw throwAuthorizationError('recaptchaToken required');

    const validCaptcha = await verifyCaptchaToken({ token: recaptchaToken, ip: ctx.ip });
    if (!validCaptcha) throw throwAuthorizationError('Captcha Failed. Please try again.');

    const result = await getPaymentIntent({
      ...input,
      user: {
        id,
        email,
      },
      customerId,
    });

    return result;
  } catch (error) {
    throw getTRPCErrorFromUnknown(error);
  }
};

export const getSetupIntentHandler = async ({
  input,
  ctx,
}: {
  input: Schema.SetupIntentCreateSchema;
  ctx: ProtectedContext;
}) => {
  try {
    const { id, email, customerId } = ctx.user;

    if (!email) throw throwAuthorizationError('email required');

    const result = await getSetupIntent({
      ...input,
      user: {
        id,
        email,
      },
      customerId,
    });

    return result;
  } catch (error) {
    throw getTRPCErrorFromUnknown(error);
  }
};

export const createCancelSubscriptionSessionHandler = async ({
  ctx,
}: {
  ctx: ProtectedContext;
}) => {
  if (!ctx.user.customerId) throw throwNotFoundError('customerId not found');
  try {
    return await createCancelSubscriptionSession({ customerId: ctx.user.customerId });
  } catch (error) {
    throw getTRPCErrorFromUnknown(error);
  }
};

export const cancelSubscriptionWithFallbackHandler = async ({
  ctx,
}: {
  ctx: ProtectedContext;
}) => {
  if (!ctx.user.customerId) throw throwNotFoundError('customerId not found');
  try {
    return await cancelSubscriptionWithFallback({
      customerId: ctx.user.customerId,
      userId: ctx.user.id,
    });
  } catch (error) {
    throw getTRPCErrorFromUnknown(error);
  }
};
