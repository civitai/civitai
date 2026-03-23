import { env } from '~/env/server';
import { logToAxiom } from '../logging/client';
import {
  getMultipliersForUser,
  getTransactionByExternalId,
  grantBuzzPurchase,
} from './buzz.service';
import nowpaymentsCaller from '~/server/http/nowpayments/nowpayments.caller';
import type { NOWPayments } from '~/server/http/nowpayments/nowpayments.schema';
import { dbRead, dbWrite } from '~/server/db/client';
import { withDistributedLock } from '~/server/utils/distributed-lock';
import { signalClient } from '~/utils/signal-client';
import { SignalMessages, NotificationCategory } from '~/server/common/enums';
import { createNotification } from '~/server/services/notification.service';
import type { RedisKeyTemplateCache } from '~/server/redis/client';
import { redis, REDIS_KEYS } from '~/server/redis/client';
import { CacheTTL } from '~/server/common/constants';
import { fetchThroughCache } from '~/server/utils/cache-helpers';
import {
  getChainConfig,
  getChainForNetwork,
  isDepositComplete,
  outcomeAmountToBuzz,
} from '~/server/common/chain-config';

/** IPN callback URL — configurable for dev (webhook.site) vs prod */
const getIpnCallbackUrl = () =>
  env.NOWPAYMENTS_IPN_URL ?? `${env.NEXTAUTH_URL}/api/webhooks/nowpayments`;

const log = async (data: MixedObject) => {
  await logToAxiom({ name: 'nowpayments-service', type: 'error', ...data }).catch();
};

/** Max number of concurrent requests when fetching min amounts for currencies */
const MAX_CONCURRENT_MIN_AMOUNT_REQUESTS = 10;

export const getDepositAddress = async (userId: number, chain = 'evm') => {
  const config = getChainConfig(chain);
  if (!config) throw new Error(`Unsupported chain: ${chain}`);

  // Check if wallet already exists before acquiring lock
  const existing = await dbRead.cryptoWallet.findUnique({
    where: { userId_chain: { userId, chain } },
  });
  if (existing?.wallet) {
    return {
      address: existing.wallet,
      paymentId: existing.smartAccount ? Number(existing.smartAccount) : null,
      chain,
    };
  }

  const result = await withDistributedLock(
    { key: `crypto-deposit:create:${userId}:${chain}` },
    async () => {
      // Double-check inside lock
      const existingInLock = await dbRead.cryptoWallet.findUnique({
        where: { userId_chain: { userId, chain } },
      });
      if (existingInLock?.wallet) {
        return {
          address: existingInLock.wallet,
          paymentId: existingInLock.smartAccount ? Number(existingInLock.smartAccount) : null,
          chain,
        };
      }

      const payment = await nowpaymentsCaller.createPayment({
        price_amount: 20, // Must exceed min amount for all chains (USDTTRC20 requires ~$10)
        price_currency: 'usd',
        pay_currency: config.targetCurrency,
        order_id: `user:${userId}`,
        ipn_callback_url: getIpnCallbackUrl(),
      });

      if (!payment) {
        throw new Error('Failed to create deposit address via NowPayments');
      }

      await dbWrite.cryptoWallet.create({
        data: {
          userId,
          chain,
          wallet: payment.pay_address,
          smartAccount: String(payment.payment_id),
          payCurrency: config.targetCurrency,
        },
      });

      return {
        address: payment.pay_address,
        paymentId: payment.payment_id,
        chain,
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

  // Determine chain from pay_address → wallet → chain lookup
  let chain: string | null = null;
  if (event.pay_address) {
    const wallet = await dbRead.cryptoWallet.findUnique({
      where: { wallet: event.pay_address },
    });
    chain = wallet?.chain ?? null;
  }

  // Compute buzz amount for finished/partially_paid deposits
  let buzzAmount = 0;
  let bonusBuzz: number | null = null;
  let multiplierInt: number | null = null;
  let transactionId: string | undefined;

  if (isDepositComplete(webhookStatus)) {
    const outcomeAmount = event.outcome_amount;
    if (!outcomeAmount || outcomeAmount <= 0) {
      await log({
        message: 'Finished deposit with no outcome_amount',
        paymentId,
        event,
      });
    } else {
      buzzAmount = outcomeAmountToBuzz(outcomeAmount);

      // Capture multiplier info before granting buzz
      const { purchasesMultiplier } = await getMultipliersForUser(userId);
      if (purchasesMultiplier > 1) {
        multiplierInt = Math.round(purchasesMultiplier * 100);
        bonusBuzz = Math.floor(buzzAmount * purchasesMultiplier) - buzzAmount;
      }

      transactionId = await grantBuzzPurchase({
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
    }
  }

  // Upsert the CryptoDeposit record on every webhook status
  if (event.payment_id) {
    try {
      const depositData = {
        status: isDepositComplete(webhookStatus) ? 'finished' : webhookStatus,
        payCurrency: event.pay_currency ?? 'unknown',
        payAmount: event.actually_paid ?? null,
        outcomeAmount: event.outcome_amount ?? null,
        buzzCredited: buzzAmount > 0 ? buzzAmount : null,
        bonusBuzz,
        multiplier: multiplierInt,
        depositFee: event.fee ? parseFloat(event.fee.depositFee) : null,
        serviceFee: event.fee ? parseFloat(event.fee.serviceFee) : null,
        feeCurrency: event.fee?.currency ?? null,
        paidFiat: event.actually_paid_at_fiat ?? null,
        chain,
      };
      await dbWrite.cryptoDeposit.upsert({
        where: { paymentId: BigInt(event.payment_id) },
        create: {
          paymentId: BigInt(event.payment_id),
          userId,
          ...depositData,
        },
        update: depositData,
      });
    } catch (e) {
      await log({
        message: 'Failed to upsert CryptoDeposit record',
        paymentId,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  // Send signal for ALL statuses (confirming, finished)
  const normalizedStatus = isDepositComplete(webhookStatus) ? 'finished' : webhookStatus;
  await signalClient.send({
    userId,
    target: SignalMessages.CryptoDepositUpdate,
    data: {
      paymentId: event.payment_id,
      status: normalizedStatus,
      amount: event.actually_paid,
      currency: event.pay_currency,
      outcomeAmount: event.outcome_amount,
    },
  });

  // Send persistent notification for completed deposits
  if (isDepositComplete(webhookStatus) && buzzAmount > 0) {
    const notificationType =
      webhookStatus === 'partially_paid' ? 'partially-paid' : 'deposit-confirmed';

    await createNotification({
      key: `${notificationType}:np-${paymentId}`,
      type: notificationType,
      category: NotificationCategory.Buzz,
      details: { buzzAmount, bonusBuzz: bonusBuzz ?? 0 },
      userId,
    }).catch((e) =>
      log({
        message: 'Failed to create deposit notification',
        paymentId,
        userId,
        error: e instanceof Error ? e.message : String(e),
      })
    );
  }

  return { userId, buzzAmount, transactionId };
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

  if (!isDepositComplete(payment.payment_status)) {
    throw new Error(`Payment ${paymentId} is not complete (status: ${payment.payment_status})`);
  }

  const orderId = payment.order_id;
  if (!orderId || !orderId.startsWith('user:')) {
    throw new Error(`Payment ${paymentId} has invalid order_id: ${orderId}`);
  }

  // Build a webhook-like event from the GET response
  const event: NOWPayments.WebhookEvent = {
    payment_id:
      typeof payment.payment_id === 'string'
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

  return processDeposit(paymentId, payment.payment_status, event);
};

/** Max concurrent requests to NP API when fetching individual payments */
const RECONCILE_FETCH_CONCURRENCY = 5;
/** Max concurrent deposit processing (buzz grants, DB writes, notifications) */
const RECONCILE_PROCESS_CONCURRENCY = 3;

type ReconcileDetail = {
  paymentId: string | number;
  status: string;
  action: 'already_processed' | 'processed' | 'failed' | 'skipped';
  error?: string;
  userId?: number;
  buzzAmount?: number;
};

/**
 * Reconcile NOWPayments deposits by date range or specific payment IDs.
 * Fetches payments from the NP API, checks if buzz was granted,
 * and processes any missed deposits. Safe to re-run (idempotent).
 */
export const reconcileDeposits = async ({
  dateFrom,
  dateTo,
  paymentIds,
}: {
  dateFrom?: string;
  dateTo?: string;
  paymentIds?: number[];
}) => {
  // 1. Fetch payments from NP API
  const allPayments = paymentIds?.length
    ? await fetchPaymentsByIds(paymentIds)
    : dateFrom && dateTo
    ? await fetchPaymentsByDateRange(dateFrom, dateTo)
    : [];

  // 2. Filter for completed payments only
  const completedPayments = allPayments.filter((p) => isDepositComplete(p.payment_status));

  // 3. Process each completed payment with bounded concurrency
  const details = await mapWithConcurrency(
    completedPayments,
    RECONCILE_PROCESS_CONCURRENCY,
    (payment) => reconcileSinglePayment(payment)
  );

  const results = {
    totalPayments: allPayments.length,
    completedPayments: completedPayments.length,
    alreadyProcessed: 0,
    newlyProcessed: 0,
    failed: 0,
    skipped: 0,
    details,
  };

  for (const d of details) {
    if (d.action === 'already_processed') results.alreadyProcessed++;
    else if (d.action === 'processed') results.newlyProcessed++;
    else if (d.action === 'failed') results.failed++;
    else if (d.action === 'skipped') results.skipped++;
  }

  return results;
};

/** Fetch individual payments by ID with bounded concurrency. */
async function fetchPaymentsByIds(ids: number[]): Promise<NOWPayments.CreatePaymentResponse[]> {
  const results = await mapWithConcurrency(ids, RECONCILE_FETCH_CONCURRENCY, (id) =>
    nowpaymentsCaller.getPaymentStatus(id)
  );
  return results.filter((p): p is NOWPayments.CreatePaymentResponse => p != null);
}

/** Paginate through NP list API for a date range. Pages are fetched sequentially. */
async function fetchPaymentsByDateRange(
  dateFrom: string,
  dateTo: string
): Promise<NOWPayments.CreatePaymentResponse[]> {
  const PAGE_SIZE = 100;
  let page = 0;
  const allPayments: NOWPayments.CreatePaymentResponse[] = [];

  while (true) {
    const result = await nowpaymentsCaller.getListPayments({
      limit: PAGE_SIZE,
      page,
      dateFrom,
      dateTo,
      sortBy: 'created_at',
      orderBy: 'asc',
    });

    if (!result || result.data.length === 0) break;
    allPayments.push(...result.data);

    if (result.data.length < PAGE_SIZE) break;
    page++;
  }

  return allPayments;
}

/** Process a single payment: check idempotency, validate, grant buzz. */
async function reconcileSinglePayment(
  payment: NOWPayments.CreatePaymentResponse
): Promise<ReconcileDetail> {
  const paymentId = payment.payment_id;
  const externalId = `np-deposit-${paymentId}`;

  // Check if buzz already granted
  try {
    const existing = await getTransactionByExternalId(externalId);
    if (existing) {
      return { paymentId, status: payment.payment_status, action: 'already_processed' };
    }
  } catch {
    // If lookup fails, proceed to process (processDeposit is idempotent)
  }

  // Validate order_id format
  if (!payment.order_id?.startsWith('user:')) {
    return {
      paymentId,
      status: payment.payment_status,
      action: 'skipped',
      error: `Invalid order_id: ${payment.order_id}`,
    };
  }

  // Process the deposit
  try {
    const event: NOWPayments.WebhookEvent = {
      payment_id: typeof paymentId === 'string' ? parseInt(paymentId, 10) : paymentId,
      payment_status: payment.payment_status,
      order_id: payment.order_id,
      outcome_amount: payment.outcome_amount ?? undefined,
      actually_paid: payment.actually_paid ? Number(payment.actually_paid) : undefined,
      pay_currency: payment.pay_currency,
      pay_address: payment.pay_address,
      parent_payment_id: payment.parent_payment_id,
    };

    const depositResult = await processDeposit(
      typeof paymentId === 'string' ? parseInt(paymentId, 10) : paymentId,
      payment.payment_status,
      event
    );

    return {
      paymentId,
      status: payment.payment_status,
      action: 'processed',
      userId: depositResult.userId,
      buzzAmount: depositResult.buzzAmount,
    };
  } catch (e) {
    return {
      paymentId,
      status: payment.payment_status,
      action: 'failed',
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

/** Hard cap on perPage to prevent abuse */
const MAX_PER_PAGE = 25;

export const getDepositHistory = async (userId: number, page = 1, perPage = 3) => {
  page = Math.max(1, page);
  perPage = Math.min(Math.max(1, perPage), MAX_PER_PAGE);

  const [deposits, total] = await Promise.all([
    dbRead.cryptoDeposit.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * perPage,
      take: perPage,
    }),
    dbRead.cryptoDeposit.count({ where: { userId } }),
  ]);

  return {
    deposits: deposits.map((d) => ({
      paymentId: Number(d.paymentId),
      date: d.createdAt.toISOString(),
      amountSent: d.payAmount,
      currencySent: d.payCurrency,
      outcomeAmount: d.outcomeAmount ?? 0,
      buzzCredited: d.buzzCredited,
      bonusBuzz: d.bonusBuzz,
      multiplier: d.multiplier,
      status: d.status,
      depositFee: d.depositFee,
      serviceFee: d.serviceFee,
      feeCurrency: d.feeCurrency,
      paidFiat: d.paidFiat,
      chain: d.chain,
    })),
    total,
  };
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
  chain: string | null;
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

  const selectedCodes = new Set(merchantCoins.selectedCurrencies.map((c) => c.toLowerCase()));

  // Filter full currencies to only our selected ones, and only those on supported chains
  const selectedCurrencies = fullCurrencies.currencies
    .filter((c) => selectedCodes.has(c.code.toLowerCase()))
    .filter((c) => c.network && getChainForNetwork(c.network));

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
        chain: getChainForNetwork(currency.network ?? '')?.chain ?? null,
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
  const cacheKey = `${REDIS_KEYS.CACHES.CRYPTO_CONVERSION_RATE}:${fiat}` as RedisKeyTemplateCache;
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

/** Add a 20% buffer to the minimum payment amount with a $0.05 floor */
const MIN_AMOUNT_BUFFER = 0.2;
const MIN_AMOUNT_FLOOR_USD = 0.05;

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

      const rawMin = result?.min_amount ?? null;
      const rawFiat = result?.fiat_equivalent ?? null;

      return {
        minAmount: rawMin != null ? rawMin * (1 + MIN_AMOUNT_BUFFER) : null,
        fiatEquivalent:
          rawFiat != null
            ? Math.max(rawFiat * (1 + MIN_AMOUNT_BUFFER), MIN_AMOUNT_FLOOR_USD)
            : null,
      };
    },
    { ttl: CacheTTL.md }
  );
};
