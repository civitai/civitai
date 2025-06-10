import type { Context } from '~/server/createContext';
import { throwAuthorizationError } from '~/server/utils/errorHandling';
import {
  createBuzzOrder,
  createBuzzOrderOnramp,
  getPaginatedUserTransactionHistory,
  getTransactionStatusByKey,
  getUserWalletBalance,
  processUserPendingTransactions,
} from '~/server/services/coinbase.service';
import coinbaseCaller from '~/server/http/coinbase/coinbase.caller';
import type {
  CreateBuzzCharge,
  GetPaginatedUserTransactionHistorySchema,
} from '~/server/schema/coinbase.schema';
import type { GetByIdStringInput } from '~/server/schema/base.schema';

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

export const createBuzzOrderOnrampHandler = async ({
  input,
  ctx,
}: {
  ctx: DeepNonNullable<Context>;
  input: CreateBuzzCharge;
}) => {
  if (!ctx.user.email) {
    throw throwAuthorizationError('Email is required to create a transaction');
  }

  return createBuzzOrderOnramp({
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
  return getTransactionStatusByKey({
    userId: ctx.user.id,
    key: id,
  });
};

export const getUserWalletBalanceHandler = async ({ ctx }: { ctx: DeepNonNullable<Context> }) => {
  if (!ctx.user.email) {
    throw throwAuthorizationError('Email is required to get wallet balance');
  }

  return getUserWalletBalance(ctx.user.id);
};

export const getPaginatedUserTransactionsHandler = async ({
  input,
  ctx,
}: {
  input: GetPaginatedUserTransactionHistorySchema;
  ctx: DeepNonNullable<Context>;
}) => {
  if (!ctx.user.email) {
    throw throwAuthorizationError('Email is required to get transactions');
  }

  return getPaginatedUserTransactionHistory({
    ...input,
    userId: ctx.user.id,
  });
};

export const processUserPendingTransactionsHandler = async ({
  ctx,
}: {
  ctx: DeepNonNullable<Context>;
}) => {
  if (!ctx.user.email) {
    throw throwAuthorizationError('Email is required to process transactions');
  }

  return processUserPendingTransactions(ctx.user.id);
};
