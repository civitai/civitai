import type { Context } from '~/server/createContext';
import type {
  DepositHistoryInput,
  GetBuzzConversionRateInput,
  GetDepositAddressInput,
  GetMinAmountInput,
} from '~/server/schema/nowpayments.schema';
import {
  getDepositAddress,
  getBuzzConversionRate,
  getDepositHistory,
  getMinAmount,
  getSupportedCurrencies,
} from '~/server/services/nowpayments.service';

export const getDepositAddressHandler = async ({
  ctx,
  input,
}: {
  ctx: DeepNonNullable<Context>;
  input: GetDepositAddressInput;
}) => {
  return getDepositAddress(ctx.user.id, input.chain);
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

