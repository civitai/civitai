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
  getUserSubscription,
  getBuzzPackages,
} from './../services/stripe.service';
import { Context } from '~/server/createContext';
import * as Schema from '../schema/stripe.schema';

import { getPlans } from '~/server/services/stripe.service';

export const getPlansHandler = async () => {
  return await getPlans();
};

export const getUserSubscriptionHandler = async ({ ctx }: { ctx: Context }) => {
  if (!ctx.user?.id || !ctx.user.subscriptionId) return null;
  return await getUserSubscription({ userId: ctx.user.id });
};

export const createCustomerHandler = async ({
  input,
  ctx,
}: {
  input: Schema.CreateCustomerInput;
  ctx: DeepNonNullable<Context>;
}) => {
  return await createCustomer({ ...input });
};

export const createDonateSessionHandler = async ({
  input: { returnUrl },
  ctx,
}: {
  input: Schema.CreateDonateSessionInput;
  ctx: DeepNonNullable<Context>;
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
  input: { priceId },
  ctx,
}: {
  input: Schema.CreateSubscribeSessionInput;
  ctx: DeepNonNullable<Context>;
}) => {
  const { id, email, customerId } = ctx.user;
  if (!email) throw throwAuthorizationError('email required');
  const result = await createSubscribeSession({
    priceId,
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
  ctx: DeepNonNullable<Context>;
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
