import { getTRPCErrorFromUnknown } from '@trpc/server';
import { Context } from '~/server/createContext';
import nowpaymentsCaller from '~/server/http/nowpayments/nowpayments.caller';
import { NOWPayments } from '~/server/http/nowpayments/nowpayments.schema';
import { verifyCaptchaToken } from '~/server/recaptcha/client';
import {
  CreatePaymentInvoiceInput,
  PriceEstimateInput,
  TransactionCreateInput,
} from '~/server/schema/nowpayments.schema';
import { throwAuthorizationError } from '~/server/utils/errorHandling';
import Decimal from 'decimal.js';
import { env } from 'process';
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
  const defaultCurrency = 'usd';
  const targetCurrency = input.currencyTo ?? 'btc'; // Bitcoin

  const estimate = await nowpaymentsCaller.getPriceEstimate({
    amount: input.unitAmount / 100,
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

  // 1 =  minAmount is greater than estimate.
  // We use decimal.js because bitcoin amounts can be very small and we need to compare them accurately.
  const isValid = new Decimal(currency?.min_amount).comparedTo(estimate?.estimated_amount) < 1;

  console.log({ isValid, currency, estimate });

  return isValid ? estimate : null;
};

export const createPaymentInvoice = async ({
  input,
  ctx,
}: {
  ctx: DeepNonNullable<Context>;
  input: CreatePaymentInvoiceInput;
}) => {
  if (!ctx.user.email) {
    throw throwAuthorizationError('Email is required to create a transaction');
  }

  const callbackUrl =
    `${env.NEXTAUTH_URL}/api/webhooks/nowpayments?` +
    new URLSearchParams([['buzzAmount', input.buzzAmount.toString()]]);

  const successUrl =
    `${env.NEXTAUTH_URL}/payment/nowpayments/success?` +
    new URLSearchParams([['buzzAmount', input.buzzAmount.toString()]]);

  const orderId = `${ctx.user.id}-${input.buzzAmount}-${new Date().getTime()}`;

  const invoice = await nowpaymentsCaller.createPaymentInvoice({
    price_amount: new Decimal(input.unitAmount).dividedBy(100).toNumber(), // Nowpayuemnts use actual amount. Not multiplied by 100
    price_currency: 'usd',
    order_id: orderId,
    order_description: `Buzz purchase for ${input.buzzAmount} BUZZ`,
    // is_fixed_rate: false,
    // is_fee_paid_by_user: true,
    ipn_callback_url: callbackUrl,
    success_url: successUrl,
    cancel_url: env.NEXTAUTH_URL,
  });

  console.log(invoice);

  if (!invoice) {
    throw new Error('Failed to create invoice');
  }

  return invoice;
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
