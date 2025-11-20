import type { Context } from '~/server/context/types';
import { throwAuthorizationError } from '~/server/utils/errorHandling';
import {
  createBuzzOrder,
  getTransactionStatusByUniqueId,
  isAPIHealthy,
} from '~/server/services/emerchantpay.service';
import type { CreateBuzzCharge } from '~/server/services/emerchantpay.service';
import type { GetByIdStringInput } from '~/server/schema/base.schema';

export const getStatus = async () => {
  return isAPIHealthy();
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

export const getTransactionStatusHandler = async ({
  ctx,
  input: { id },
}: {
  ctx: DeepNonNullable<Context>;
  input: GetByIdStringInput;
}) => {
  return getTransactionStatusByUniqueId({
    userId: ctx.user.id,
    uniqueId: id,
  });
};
