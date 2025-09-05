import type { Context } from '~/server/createContext';
import { throwAuthorizationError } from '~/server/utils/errorHandling';
import { createBuzzOrder } from '~/server/services/coinbase.service';
import coinbaseCaller from '~/server/http/coinbase/coinbase.caller';
import type { CreateBuzzCharge } from '~/server/schema/coinbase.schema';

export const getStatus = async () => {
  return coinbaseCaller.isAPIHealthy();
};

export const createBuzzOrderHandler = async ({
  input,
  ctx,
}: {
  ctx: DeepNonNullable<Context>;
  input: CreateBuzzCharge;
}) => {
  if (!ctx.user.email) {
    throw throwAuthorizationError('Email is required to create a transaction');
  }

  return createBuzzOrder({
    ...input,
    userId: ctx.user.id,
  });
};

