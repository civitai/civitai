import type { Context } from '~/server/createContext';
import type {
  DepositHistoryInput,
  GetBuzzConversionRateInput,
  GetMinAmountInput,
} from '~/server/schema/nowpayments.schema';
import {
  bustDepositCache,
  createDepositAddress,
  getBuzzConversionRate,
  getDepositHistory,
  getMinAmount,
  getSupportedCurrencies,
} from '~/server/services/nowpayments.service';

export const createDepositAddressHandler = async ({
  ctx,
}: {
  ctx: DeepNonNullable<Context>;
}) => {
  return createDepositAddress(ctx.user.id);
};

export const getDepositHistoryHandler = async ({
  ctx,
  input,
}: {
  ctx: DeepNonNullable<Context>;
  input: DepositHistoryInput;
}) => {
  return getDepositHistory(ctx.user.id, input.page, input.perPage);
};

export const getSupportedCurrenciesHandler = async () => {
  return getSupportedCurrencies();
};

export const getMinAmountHandler = async ({ input }: { input: GetMinAmountInput }) => {
  return getMinAmount(input.currencyCode, input.fiat);
};

export const getBuzzConversionRateHandler = async ({
  input,
}: {
  input: GetBuzzConversionRateInput;
}) => {
  return getBuzzConversionRate(input.fiat);
};

export const bustDepositCacheHandler = async ({
  ctx,
}: {
  ctx: DeepNonNullable<Context>;
}) => {
  await bustDepositCache(ctx.user.id);
  return { success: true };
};
