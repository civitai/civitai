import { env } from '~/env/server';
import { logToAxiom } from '../logging/client';
import { grantBuzzPurchase } from './buzz.service';
import nowpaymentsCaller from '~/server/http/nowpayments/nowpayments.caller';
import type { NOWPayments } from '~/server/http/nowpayments/nowpayments.schema';
import { dbRead, dbWrite } from '~/server/db/client';
import { withDistributedLock } from '~/server/utils/distributed-lock';
import { signalClient } from '~/utils/signal-client';
import { SignalMessages } from '~/server/common/enums';
import type { RedisKeyTemplateCache } from '~/server/redis/client';
import { redis, REDIS_KEYS } from '~/server/redis/client';
import { CacheTTL } from '~/server/common/constants';
import { fetchThroughCache } from '~/server/utils/cache-helpers';

const log = async (data: MixedObject) => {
  await logToAxiom({ name: 'nowpayments-service', type: 'error', ...data }).catch();
};

/** Max number of concurrent requests when fetching min amounts for currencies */
const MAX_CONCURRENT_MIN_AMOUNT_REQUESTS = 10;

/** Helper to build a typed Redis cache key for crypto payment status */
const paymentCacheKey = (paymentId: number | string): RedisKeyTemplateCache =>
  `${REDIS_KEYS.CACHES.CRYPTO_PAYMENT_STATUS}:${paymentId}` as RedisKeyTemplateCache;

export const createDepositAddress = async (userId: number) => {
  // Check if wallet already exists before acquiring lock
  const existing = await dbRead.cryptoWallet.findUnique({ where: { userId } });
  if (existing?.wallet) {
    return {
      address: existing.wallet,
      paymentId: existing.smartAccount ? Number(existing.smartAccount) : null,
    };
  }

  const result = await withDistributedLock(
    { key: `crypto-deposit:create:${userId}` },
    async () => {
      // Double-check inside lock
      const existingInLock = await dbRead.cryptoWallet.findUnique({ where: { userId } });
      if (existingInLock?.wallet) {
        return {
          address: existingInLock.wallet,
          paymentId: existingInLock.smartAccount ? Number(existingInLock.smartAccount) : null,
        };
      }

      const payment = await nowpaymentsCaller.createPayment({
        price_amount: 1,
        price_currency: 'usd',
        pay_currency: 'usdcbase',
        order_id: `user:${userId}`,
        ipn_callback_url: `${env.NEXTAUTH_URL}/api/webhooks/nowpayments`,
      });

      if (!payment) {
        throw new Error('Failed to create deposit address via NowPayments');
      }

      await dbWrite.cryptoWallet.upsert({
        where: { userId },
        create: {
          userId,
          wallet: payment.pay_address,
          smartAccount: String(payment.payment_id),
        },
        update: {
          wallet: payment.pay_address,
          smartAccount: String(payment.payment_id),
        },
      });

      return {
        address: payment.pay_address,
        paymentId: payment.payment_id,
      };
    }
  );

  if (!result) {
    throw new Error('Could not acquire lock to create deposit address. Please try again.');
  }

  return result;
};

export const processDeposit = async (
  paymentId: number,
  webhookStatus: string,
  event: NOWPayments.WebhookEvent
) => {
  // Extract userId from order_id format "user:{userId}"
  const orderId = event.order_id;
  if (!orderId || !orderId.startsWith('user:')) {
    await log({
      message: 'Invalid order_id format in deposit webhook',
      paymentId,
      orderId,
    });
    throw new Error('Invalid order_id format');
  }

  const userId = parseInt(orderId.split(':')[1], 10);
  if (!userId || isNaN(userId)) {
    await log({
      message: 'Could not parse userId from order_id',
      paymentId,
      orderId,
    });
    throw new Error('Invalid userId in order_id');
  }

  // Send signal for ALL statuses (confirming, confirmed, finished)
  await signalClient.send({
    userId,
    target: SignalMessages.CryptoDepositUpdate,
    data: {
      paymentId: event.payment_id,
      status: event.payment_status,
      amount: event.actually_paid,
      currency: event.pay_currency,
      outcomeAmount: event.outcome_amount,
    },
  });

  // Bust cached payment data so next fetch gets fresh state
  await redis.del(paymentCacheKey(event.payment_id!));
  if (event.parent_payment_id) {
    await redis.del(paymentCacheKey(event.parent_payment_id));
  }

  // Only grant buzz on finished status
  if (webhookStatus === 'finished') {
    const outcomeAmount = event.outcome_amount;
    if (!outcomeAmount || outcomeAmount <= 0) {
      await log({
        message: 'Finished deposit with no outcome_amount',
        paymentId,
        event,
      });
      return { userId, buzzAmount: 0 };
    }

    const buzzAmount = Math.floor(outcomeAmount * 1000);

    const transactionId = await grantBuzzPurchase({
      userId,
      amount: buzzAmount,
      externalTransactionId: `np-deposit-${paymentId}`,
      provider: 'nowpayments',
      paymentId: event.payment_id,
    });

    if (!transactionId) {
      await log({
        message: 'Failed to create buzz transaction for deposit',
        paymentId,
        userId,
        buzzAmount,
      });
    }

    // Store webhook-only fee data (not available via GET endpoint)
    if (event.payment_id) {
      try {
        await dbWrite.cryptoDepositFee.upsert({
          where: { paymentId: event.payment_id },
          create: {
            paymentId: event.payment_id,
            depositFee: event.fee ? parseFloat(event.fee.depositFee) : 0,
            serviceFee: event.fee ? parseFloat(event.fee.serviceFee) : 0,
            feeCurrency: event.fee?.currency ?? 'usdcbase',
            paidFiat: event.actually_paid_at_fiat ?? null,
          },
          update: {
            depositFee: event.fee ? parseFloat(event.fee.depositFee) : 0,
            serviceFee: event.fee ? parseFloat(event.fee.serviceFee) : 0,
            feeCurrency: event.fee?.currency ?? 'usdcbase',
            paidFiat: event.actually_paid_at_fiat ?? null,
          },
        });
      } catch (e) {
        await log({
          message: 'Failed to store deposit fee data',
          paymentId,
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }

    return { userId, buzzAmount, transactionId };
  }

  return { userId, buzzAmount: 0 };
};

/**
 * Reprocess a deposit by fetching its current state from NowPayments.
 * Used by the mod reprocess-order endpoint when the webhook was missed.
 */
export const reprocessDeposit = async (paymentId: number) => {
  const payment = await nowpaymentsCaller.getPaymentStatus(paymentId);
  if (!payment) {
    throw new Error(`Payment ${paymentId} not found on NowPayments`);
  }

  if (payment.payment_status !== 'finished') {
    throw new Error(
      `Payment ${paymentId} is not finished (status: ${payment.payment_status})`
    );
  }

  const orderId = payment.order_id;
  if (!orderId || !orderId.startsWith('user:')) {
    throw new Error(`Payment ${paymentId} has invalid order_id: ${orderId}`);
  }

  // Build a webhook-like event from the GET response
  const event: NOWPayments.WebhookEvent = {
    payment_id: typeof payment.payment_id === 'string'
      ? parseInt(payment.payment_id, 10)
      : payment.payment_id,
    payment_status: payment.payment_status,
    order_id: payment.order_id,
    outcome_amount: payment.outcome_amount,
    actually_paid: payment.actually_paid ? Number(payment.actually_paid) : undefined,
    pay_currency: payment.pay_currency,
    pay_address: payment.pay_address,
    parent_payment_id: payment.parent_payment_id,
  };

  return processDeposit(paymentId, 'finished', event);
};

// Cached wrapper for individual payment status lookups
const getCachedPaymentStatus = async (paymentId: number | string) => {
  return fetchThroughCache(
    paymentCacheKey(paymentId),
    async () => nowpaymentsCaller.getPaymentStatus(paymentId),
    { ttl: CacheTTL.hour }
  );
};

/** Hard cap on perPage to prevent abuse */
const MAX_PER_PAGE = 25;

export const getDepositHistory = async (
  userId: number,
  page: number = 1,
  perPage: number = 3
) => {
  // Clamp inputs to safe ranges
  page = Math.max(1, page);
  perPage = Math.min(Math.max(1, perPage), MAX_PER_PAGE);

  const wallet = await dbRead.cryptoWallet.findUnique({ where: { userId } });
  if (!wallet?.smartAccount) {
    return { deposits: [], total: 0 };
  }

  // Get parent payment to read payment_extra_ids (cached)
  const parentPayment = await getCachedPaymentStatus(wallet.smartAccount);
  if (!parentPayment) {
    await log({
      message: 'Failed to fetch parent payment for deposit history',
      userId,
      smartAccount: wallet.smartAccount,
    });
    return { deposits: [], total: 0 };
  }

  // Build list of all payment IDs: child payments (repeats) + the parent payment itself
  const extraIds: number[] = parentPayment.payment_extra_ids ?? [];
  const parentId =
    typeof parentPayment.payment_id === 'string'
      ? parseInt(parentPayment.payment_id, 10)
      : parentPayment.payment_id;

  // Include the parent payment if it has actually been paid
  const allIds = [...extraIds];
  if (parentPayment.actually_paid && Number(parentPayment.actually_paid) > 0) {
    allIds.push(parentId);
  }

  // Sort newest first (highest IDs are newest)
  const sortedIds = allIds.sort((a, b) => b - a);
  const total = sortedIds.length;

  // Paginate
  const start = (page - 1) * perPage;
  const pageIds = sortedIds.slice(start, start + perPage);

  // Fetch fee data for page IDs in one query (non-critical, degrade gracefully)
  let feeMap = new Map<number, { depositFee: number; serviceFee: number; feeCurrency: string | null; paidFiat: number | null }>();
  try {
    const feeRecords = await dbRead.cryptoDepositFee.findMany({
      where: { paymentId: { in: pageIds.map(BigInt) } },
    });
    feeMap = new Map(feeRecords.map((f) => [Number(f.paymentId), f]));
  } catch (e) {
    // Fee data is supplemental — continue without it
  }

  // Fetch payment details (all cached individually)
  const deposits = (await Promise.all(
    pageIds.map(async (paymentId) => {
      const payment = await getCachedPaymentStatus(paymentId);
      if (!payment) return null;

      const outcomeAmount = payment.outcome_amount ?? 0;
      const buzzCredited =
        payment.payment_status === 'finished' ? Math.floor(outcomeAmount * 1000) : null;
      const fee = feeMap.get(paymentId);

      return {
        paymentId: payment.payment_id,
        date: payment.created_at,
        amountSent: payment.actually_paid ?? payment.pay_amount,
        currencySent: payment.pay_currency,
        outcomeAmount,
        buzzCredited,
        status: payment.payment_status,
        depositFee: fee?.depositFee ?? null,
        serviceFee: fee?.serviceFee ?? null,
        feeCurrency: fee?.feeCurrency ?? null,
        paidFiat: fee?.paidFiat ?? null,
      };
    })
  ));

  return {
    deposits: deposits.filter(Boolean),
    total,
  };
};

export const bustDepositCache = async (userId: number) => {
  const wallet = await dbRead.cryptoWallet.findUnique({ where: { userId } });
  if (!wallet?.smartAccount) return;

  // Bust the parent payment cache (which contains payment_extra_ids)
  await redis.del(paymentCacheKey(wallet.smartAccount));

  // Bust all known child payment caches
  const parentPayment = await nowpaymentsCaller.getPaymentStatus(wallet.smartAccount);
  if (parentPayment?.payment_extra_ids) {
    await Promise.all(
      parentPayment.payment_extra_ids.map((id) => redis.del(paymentCacheKey(id)))
    );
  }
};

export type SupportedCurrencyNetwork = {
  code: string;
  name: string;
  network: string | null | undefined;
  ticker: string | null | undefined;
  logoUrl: string | null | undefined;
  isStable: boolean;
  minAmount: number | null;
  minAmountUsd: number | null;
};

export type SupportedCurrencyGroup = {
  ticker: string;
  name: string;
  networks: SupportedCurrencyNetwork[];
};

const CACHE_KEY = REDIS_KEYS.CACHES.SUPPORTED_CRYPTO_CURRENCIES;

/**
 * Run async tasks with bounded concurrency.
 * Returns results in the same order as the input items.
 */
async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < items.length) {
      const idx = nextIndex++;
      results[idx] = await fn(items[idx]);
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, items.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

export const getSupportedCurrencies = async (): Promise<SupportedCurrencyGroup[]> => {
  // Check cache first
  const cached = await redis.packed.get<SupportedCurrencyGroup[]>(CACHE_KEY);
  if (cached) return cached;

  const [merchantCoins, fullCurrencies] = await Promise.all([
    nowpaymentsCaller.getMerchantCoins(),
    nowpaymentsCaller.getFullCurrencies(),
  ]);

  if (!merchantCoins || !fullCurrencies) {
    await log({
      message: 'Failed to fetch currency data from NowPayments',
      hasMerchantCoins: !!merchantCoins,
      hasFullCurrencies: !!fullCurrencies,
    });
    return [];
  }

  const selectedCodes = new Set(
    merchantCoins.selectedCurrencies.map((c) => c.toLowerCase())
  );

  // Filter full currencies to only our selected ones
  const selectedCurrencies = fullCurrencies.currencies.filter((c) =>
    selectedCodes.has(c.code.toLowerCase())
  );

  // Fetch min amounts with bounded concurrency to avoid overwhelming NowPayments API
  const currenciesWithMin: SupportedCurrencyNetwork[] = await mapWithConcurrency(
    selectedCurrencies,
    MAX_CONCURRENT_MIN_AMOUNT_REQUESTS,
    async (currency) => {
      const minAmount = await nowpaymentsCaller.getMinimumPaymentAmount({
        currency_from: currency.code,
        currency_to: 'usdcbase',
        fiat_equivalent: 'usd',
      });

      return {
        code: currency.code,
        name: currency.name,
        network: currency.network,
        ticker: currency.ticker,
        logoUrl: currency.logo_url,
        isStable: currency.is_stable ?? false,
        minAmount: minAmount?.min_amount ?? null,
        minAmountUsd: minAmount?.fiat_equivalent ?? null,
      };
    }
  );

  // Group by ticker
  const grouped: Record<string, SupportedCurrencyGroup> = {};

  for (const currency of currenciesWithMin) {
    const ticker = (currency.ticker ?? currency.code).toLowerCase();
    if (!grouped[ticker]) {
      grouped[ticker] = {
        ticker,
        name: currency.name,
        networks: [],
      };
    }
    grouped[ticker].networks.push(currency);
  }

  const result = Object.values(grouped);

  // Cache for 3 hours — currency list rarely changes
  await redis.packed.set(CACHE_KEY, result, { EX: CacheTTL.hour * 3 });

  return result;
};

export const getBuzzConversionRate = async (fiat: string) => {
  const cacheKey =
    `${REDIS_KEYS.CACHES.CRYPTO_CONVERSION_RATE}:${fiat}` as RedisKeyTemplateCache;
  return fetchThroughCache(
    cacheKey,
    async () => {
      const estimate = await nowpaymentsCaller.getPriceEstimate({
        amount: 1,
        currency_from: 'usdcbase',
        currency_to: fiat,
      });

      if (!estimate?.estimated_amount) {
        return { fiat, rate: null, buzzPerUnit: null };
      }

      // estimated_amount = how many fiat units for 1 USDC
      // 1 USDC = 1000 Buzz, so 1000 Buzz costs estimated_amount in fiat
      const rate = parseFloat(String(estimate.estimated_amount));
      if (!rate || rate <= 0) {
        return { fiat, rate: null, buzzPerUnit: null };
      }
      return {
        fiat,
        rate,
        buzzPerUnit: Math.round(1000 / rate),
      };
    },
    { ttl: CacheTTL.hour * 3 }
  );
};

export const getMinAmount = async (currencyCode: string, fiat: string) => {
  const cacheKey =
    `${REDIS_KEYS.CACHES.CRYPTO_MIN_AMOUNT}:${currencyCode}:${fiat}` as RedisKeyTemplateCache;
  return fetchThroughCache(
    cacheKey,
    async () => {
      const result = await nowpaymentsCaller.getMinimumPaymentAmount({
        currency_from: currencyCode,
        currency_to: 'usdcbase',
        fiat_equivalent: fiat,
      });

      return {
        minAmount: result?.min_amount ?? null,
        fiatEquivalent: result?.fiat_equivalent ?? null,
      };
    },
    { ttl: CacheTTL.hour * 3 }
  );
};
