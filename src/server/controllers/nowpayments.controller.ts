import { getTRPCErrorFromUnknown } from '@trpc/server';
import { Context } from '~/server/createContext';
import nowpaymentsCaller from '~/server/http/nowpayments/nowpayments.caller';
import { NOWPayments } from '~/server/http/nowpayments/nowpayments.schema';
import { verifyCaptchaToken } from '~/server/recaptcha/client';
import { PriceEstimateInput, TransactionCreateInput } from '~/server/schema/nowpayments.schema';
import { throwAuthorizationError } from '~/server/utils/errorHandling';
// import { createBuzzPurchaseTransaction } from '~/server/services/nowpayments.service';

export const getStatus = async () => {
  const res: {
    healthy: boolean;
    currencies: NOWPayments.CurrenciesResponse['currencies'] | null;
  } = {
    healthy: false,
    currencies: null,
  };

  try {
    const isAPIHealthy = await nowpaymentsCaller.isAPIHealthy();
    res.healthy = !!isAPIHealthy;

    if (!isAPIHealthy) {
      return res;
    }

    const currencyData = await nowpaymentsCaller.getCurrencies();
    res.currencies = currencyData?.currencies ?? null;

    return res;
  } catch (e) {
    console.error('Failed to get API status', e);
    return res;
  }
};

export const getPriceEstimate = async ({ input }: { input: PriceEstimateInput }) => {
  const defaultCurrency = 'USD';
  const targetCurrency = input.currencyTo ?? 'btc'; // Bitcoin

  const estimate = await nowpaymentsCaller.getPriceEstimate({
    amount: input.amount / 100,
    currency_from: defaultCurrency,
    currency_to: targetCurrency,
  });

  if (!estimate) {
    throw new Error('Failed to get price estimate');
  }

  const currencies = await nowpaymentsCaller.getCurrencies();
  if (!currencies) {
    throw new Error('Failed to get currencies');
  }

  const currency = currencies.currencies.find((c) => c.currency === targetCurrency);

  if (!currency) {
    throw new Error('Failed to get currency');
  }

  const isValid = currency?.min_amount > estimate?.estimated_amount;

  return isValid ? estimate : null;
};

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
    // return await createBuzzPurchaseTransaction({ user, ...input });
  } catch (e) {
    throw getTRPCErrorFromUnknown(e);
  }
};
