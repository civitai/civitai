import { TRPCError } from '@trpc/server';
import { createBuzzClient } from '@civitai/buzz';
import dayjs from '~/shared/utils/dayjs';
import { v4 as uuid } from 'uuid';
import { env } from '~/env/server';
import { clickhouse } from '~/server/clickhouse/client';
import { CacheTTL, specialCosmeticRewards } from '~/server/common/constants';
import { NotificationCategory } from '~/server/common/enums';
import { dbRead, dbWrite } from '~/server/db/client';
import { userMultipliersCache } from '~/server/redis/caches';
import { REDIS_KEYS } from '~/server/redis/client';
import type {
  BuzzAccountType,
  BuzzApiAccountType,
  BuzzSpendType,
} from '~/shared/constants/buzz.constants';
import type {
  ClaimWatchedAdRewardInput,
  CompleteStripeBuzzPurchaseTransactionInput,
  CreateBuzzTransactionInput,
  CreateMultiAccountBuzzTransactionInput,
  // CreateMultiAccountBuzzTransactionResponse,
  GetBuzzMovementsBetweenAccounts,
  GetBuzzMovementsBetweenAccountsResponse,
  // GetBuzzTransactionResponse,
  GetDailyBuzzCompensationInput,
  GetEarnPotentialSchema,
  // GetTransactionsReportResultSchema,
  GetTransactionsReportSchema,
  GetUserBuzzAccountSchema,
  GetUserBuzzTransactionsSchema,
  PreviewMultiAccountTransactionInput,
  // PreviewMultiAccountTransactionResponse,
  RefundMultiAccountTransactionInput,
  // RefundMultiAccountTransactionResponse,
} from '~/server/schema/buzz.schema';
import {
  getUserBuzzTransactionsResponse,
  createMultiAccountBuzzTransactionResponse,
  refundMultiAccountTransactionResponse,
  previewMultiAccountTransactionResponse,
  getBuzzTransactionResponse,
  getTransactionsReportResultSchema,
} from '~/server/schema/buzz.schema';
import {
  BuzzTypes,
  buzzSpendTypes,
  CASH_SETTLED_ALIASES,
  TransactionType,
} from '~/shared/constants/buzz.constants';
import type { PaymentIntentMetadataSchema } from '~/server/schema/stripe.schema';
import { createNotification } from '~/server/services/notification.service';
import { logToAxiom } from '~/server/logging/client';
import { createCachedObject, fetchThroughCache } from '~/server/utils/cache-helpers';
import {
  runClickHouseRead,
  throwBadRequestError,
  throwInsufficientFundsError,
  withRetries,
} from '~/server/utils/errorHandling';
import { getServerStripe } from '~/server/utils/get-server-stripe';
import { getUserByUsername, getUsers } from './user.service';
import { numberWithCommas } from '~/utils/number-helpers';
import { grantCosmetics } from '~/server/services/cosmetic.service';
import { getBuzzBulkMultiplier } from '~/server/utils/buzz-helpers';
import { isDev } from '~/env/other';
import { toPascalCase } from '~/utils/string-helpers';
// import type { BuzzAccountType as PrismaBuzzAccountType } from '~/shared/utils/prisma/enums';
// import { adWatchedReward } from '~/server/rewards';

type AccountType = 'User' | 'CreatorProgramBank' | 'CashPending' | 'CashSettled';

// Shared buzz-service client. Typed per-endpoint methods (buzzService.getAccount,
// getUserBuzzByAccountType, createTransaction, …) are used directly by the wrappers below;
// `mapError` centralises the buzz-status → tRPC-error mapping the app relied on.
export const buzzService = createBuzzClient({
  endpoint: env.BUZZ_ENDPOINT,
  log: isDev ? (message, ...args) => console.log(message, ...args) : undefined,
  mapError: (error) => {
    switch (error.status) {
      case 400:
        throw throwBadRequestError();
      case 404:
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Not found' });
      case 409:
        throw throwBadRequestError('There is a conflict with the transaction');
      default:
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'An unexpected error ocurred, please try again later',
        });
    }
  },
});

type BuzzAccountsResponse<T extends BuzzAccountType = BuzzAccountType> = Record<T, number>;
type BuzzAccountResponse = {
  id: number;
  balance: number;
  lifetimeBalance: number;
};

async function getUserBuzzAccountByAccountId(accountId: number): Promise<BuzzAccountResponse> {
  return buzzService.getAccount(accountId);
}

async function getUserBuzzAccountByAccountType(
  accountId: number,
  accountType: BuzzAccountType
): Promise<BuzzAccountResponse> {
  return buzzService.getUserBuzzByAccountType(accountId, accountType);
}

export async function getUserBuzzAccountByAccountTypes<T extends BuzzAccountType>(
  accountId: number,
  accountTypes: T[]
): Promise<BuzzAccountsResponse<T>> {
  const data = await buzzService.getUserAccounts(accountId, accountTypes);
  return Object.entries(data).reduce((acc, [key, value]) => {
    const type = BuzzTypes.toClientType(key as BuzzApiAccountType);
    if (!type) return acc;
    return { ...acc, [type]: value };
  }, {} as BuzzAccountsResponse<T>);
}

export async function getUserBuzzAccounts({ userId }: { userId: number }) {
  return await getUserBuzzAccountByAccountTypes(userId, buzzSpendTypes);
}

async function fetchUserBuzzAccounts({
  accountId,
  accountType,
  accountTypes,
}: GetUserBuzzAccountSchema) {
  return accountType
    ? getUserBuzzAccountByAccountType(accountId, accountType)
    : accountTypes
    ? getUserBuzzAccountByAccountTypes(accountId, accountTypes)
    : getUserBuzzAccountByAccountId(accountId);
}

export async function getUserBuzzAccount({
  accountId,
  accountType,
  accountTypes,
}: GetUserBuzzAccountSchema) {
  const data = await fetchUserBuzzAccounts({ accountId, accountType, accountTypes });

  let res: (Omit<BuzzAccountResponse, 'lifetimeBalance'> & {
    accountType: BuzzAccountType;
    lifetimeBalance: number | null;
  })[] = [];

  if (accountTypes) {
    res = Object.entries(data as BuzzAccountsResponse).map(([type, balance]) => ({
      id: accountId,
      balance,
      lifetimeBalance: null,
      accountType: type as BuzzAccountType,
    }));
  } else {
    res = [
      {
        ...(data as BuzzAccountResponse),
        accountType: accountType ?? 'yellow',
      },
    ];
  }

  return res;
}

export function getMultipliersForUserCache(userIds: number[]) {
  return userMultipliersCache.fetch(userIds);
}

const MAX_GLOBAL_BONUS = 5;

/**
 * Returns the global rewards bonus multiplier from the active RewardsBonusEvent.
 * The event's `multiplier` column stores value * 10 (e.g. 20 = 2x, 5 = 0.5x).
 * Returns 1 when no event is active or the value is invalid.
 * Capped at MAX_GLOBAL_BONUS to prevent config mistakes from breaking the economy.
 */
export async function getGlobalRewardsBonusMultiplier(): Promise<number> {
  try {
    const { getActiveRewardsBonusEvent } = await import(
      '~/server/services/rewards-bonus-event.service'
    );
    const event = await getActiveRewardsBonusEvent();
    if (!event) return 1;

    const parsed = event.multiplier / 10;
    if (!Number.isFinite(parsed) || parsed < 1) return 1;

    return Math.min(parsed, MAX_GLOBAL_BONUS);
  } catch {
    return 1;
  }
}

export async function getMultipliersForUser(userId: number, refresh = false) {
  if (refresh) await deleteMultipliersForUserCache(userId);

  const multipliers = await getMultipliersForUserCache([userId]);
  const base = multipliers[userId] ?? {
    purchasesMultiplier: 1,
    rewardsMultiplier: 1,
    rewardsIneligible: false,
    userId,
  };

  const { getActiveRewardsBonusEvent } = await import(
    '~/server/services/rewards-bonus-event.service'
  );
  const event = await getActiveRewardsBonusEvent();

  const rawMultiplier = event ? event.multiplier / 10 : 1;
  const globalRewardsBonus = Number.isFinite(rawMultiplier)
    ? Math.min(Math.max(rawMultiplier, 1), MAX_GLOBAL_BONUS)
    : 1;

  return {
    ...base,
    rewardsMultiplier: base.rewardsMultiplier * globalRewardsBonus,
    baseRewardsMultiplier: base.rewardsMultiplier,
    globalRewardsBonus,
    rewardsBonusEvent:
      event && globalRewardsBonus > 1
        ? {
            id: event.id,
            name: event.name,
            description: event.description,
            articleId: event.articleId,
            bannerLabel: event.bannerLabel,
            multiplier: event.multiplier,
            startsAt: event.startsAt,
            endsAt: event.endsAt,
          }
        : null,
  };
}

export function deleteMultipliersForUserCache(userId: number) {
  return userMultipliersCache.refresh(userId);
}

export async function getUserBuzzTransactions({
  accountId,
  accountType,
  ...query
}: GetUserBuzzTransactionsSchema & { accountId: number; accountType?: BuzzAccountType }) {
  // Parse incoming data
  const data = await buzzService.getAccountTransactions(accountId, {
    accountType,
    query: {
      type: query.type,
      cursor: query.cursor,
      start: query.start,
      end: query.end,
      limit: query.limit,
      descending: true,
    },
  });

  const { cursor, transactions } = getUserBuzzTransactionsResponse.parse(data);

  // Return early if no transactions
  if (transactions.length === 0) return { cursor, transactions: [] };

  // Remove duplicate user ids
  const toUserIds = new Set(
    transactions
      .filter((t) => buzzSpendTypes.some((b) => b === t.toAccountType))
      .map((t) => t.toAccountId)
  );
  const fromUserIds = new Set(
    transactions
      .filter((t) => buzzSpendTypes.some((b) => b === t.fromAccountType))
      .map((t) => t.fromAccountId)
  );
  // Remove account 0 (central bank)
  toUserIds.delete(0);
  fromUserIds.delete(0);

  const toUsers = toUserIds.size > 0 ? await getUsers({ ids: [...toUserIds] }) : [];
  const fromUsers = fromUserIds.size > 0 ? await getUsers({ ids: [...fromUserIds] }) : [];

  return {
    cursor,
    transactions: transactions.map((t) => ({
      ...t,
      // Assign each user to their corresponding transaction
      toUser: toUsers.find((u) => u.id === t.toAccountId),
      fromUser: fromUsers.find((u) => u.id === t.fromAccountId),
    })),
  };
}

export async function createBuzzTransaction({
  entityId,
  entityType,
  toAccountId,
  amount,
  details,
  insufficientFundsErrorMsg,
  ...payload
}: CreateBuzzTransactionInput & {
  fromAccountId: number;
  fromAccountType?: BuzzAccountType;
  insufficientFundsErrorMsg?: string;
}) {
  if (entityType && entityId && toAccountId === undefined) {
    const [{ userId } = { userId: undefined }] = await dbWrite.$queryRawUnsafe<
      [{ userId?: number }]
    >(`
        SELECT i."userId"
        FROM "${entityType}" i
        WHERE i.id = ${entityId}
      `);

    if (!userId) {
      throw throwBadRequestError('Entity not found');
    }

    toAccountId = userId;
  }

  if (toAccountId === undefined) {
    throw throwBadRequestError('No target account provided');
  }

  if (toAccountId === payload.fromAccountId) {
    throw throwBadRequestError('You cannot send Buzz to the same account');
  }

  if (amount <= 0) {
    throw throwBadRequestError('Invalid amount');
  }

  const account = !payload.fromAccountType
    ? await getUserBuzzAccountByAccountId(payload.fromAccountId)
    : await getUserBuzzAccountByAccountType(payload.fromAccountId, payload.fromAccountType);

  // 0 is the bank so technically, it always has funding.
  if (
    payload.fromAccountId !== 0 &&
    payload.fromAccountType !== 'creatorProgramBank' &&
    (account?.balance ?? 0) < amount
  ) {
    throw throwInsufficientFundsError(insufficientFundsErrorMsg);
  }

  const data = await buzzService.createTransaction({
    ...payload,
    details: {
      ...(details ?? {}),
      entityId: entityId ?? details?.entityId,
      entityType: entityType ?? details?.entityType,
    },
    amount,
    toAccountId,
  });

  return data;
}

export async function upsertBuzzTip({
  amount,
  entityId,
  entityType,
  fromAccountId,
  toAccountId,
  description,
  toAccountType,
}: Pick<CreateBuzzTransactionInput, 'amount' | 'toAccountId' | 'description' | 'toAccountType'> & {
  entityId: number;
  entityType: string;
  toAccountId: number;
  fromAccountId: number;
}) {
  // Store this action in the DB:
  const existingRecord = await dbWrite.buzzTip.findUnique({
    where: {
      entityType_entityId_fromUserId: {
        entityId,
        entityType,
        fromUserId: fromAccountId,
      },
    },
    select: {
      amount: true,
    },
  });

  if (existingRecord) {
    // Update it:
    await dbWrite.buzzTip.update({
      where: {
        entityType_entityId_fromUserId: {
          entityId,
          entityType,
          fromUserId: fromAccountId,
        },
      },
      data: {
        amount: existingRecord.amount + amount,
      },
    });
  } else {
    await dbWrite.buzzTip.create({
      data: {
        amount,
        entityId,
        entityType,
        toUserId: toAccountId,
        fromUserId: fromAccountId,
      },
    });
  }

  if (toAccountId !== 0) {
    const fromUser = await dbWrite.user.findUnique({
      where: { id: fromAccountId },
      select: { username: true },
    });

    await createNotification({
      type: 'tip-received',
      userId: toAccountId,
      category: NotificationCategory.Buzz,
      key: `tip-received:${uuid()}`,
      details: {
        amount: amount,
        user: fromUser?.username,
        fromUserId: fromAccountId,
        message: description,
        entityId,
        entityType,
        toAccountType,
      },
    });
  }
}

/*
 * Consider using singular transactions instead
 * Ask Koen for details!
 */
export async function createBuzzTransactionMany(
  transactions: (CreateBuzzTransactionInput & {
    fromAccountId: number;
    externalTransactionId: string;
    fromAccountType?: BuzzAccountType;
  })[]
) {
  // Protect against transactions that are not valid. A transaction with from === to
  // breaks the entire request.
  const validTransactions = transactions.filter(
    (t) => t.toAccountId !== undefined && t.fromAccountId !== t.toAccountId && t.amount > 0
  );

  const result = await buzzService.createTransactions(validTransactions);

  // The batch endpoint only reports successes + conflicts. A `conflict` is the idempotency guard
  // (a duplicate externalTransactionId — the money already moved), so it's benign. But an
  // `insufficientFunds` (or any other non-success) result is dropped from BOTH arrays: the money did
  // NOT move and it is otherwise invisible. Reconcile the counts and surface any shortfall — we can't
  // name the exact failures because successes come back as opaque ids, not externalTransactionIds.
  const unaccounted =
    validTransactions.length - result.transactions.length - result.conflicts.length;
  if (unaccounted > 0) {
    logToAxiom({
      type: 'buzz-transaction-many-dropped',
      expected: validTransactions.length,
      succeeded: result.transactions.length,
      conflicted: result.conflicts.length,
      unaccounted,
      batch: validTransactions.slice(0, 500).map((t) => ({
        externalTransactionId: t.externalTransactionId,
        fromAccountId: t.fromAccountId,
        toAccountId: t.toAccountId,
        amount: t.amount,
      })),
    }).catch(() => {});
  }

  return result;
}

const MAX_RETRIES = 3;

export async function completeStripeBuzzTransaction({
  amount,
  stripePaymentIntentId,
  details,
  userId,
  // This is a safeguard in case for some reason something fails when getting
  // payment intent or buzz from another endpoint.
  retry = 0,
}: CompleteStripeBuzzPurchaseTransactionInput & { userId: number; retry?: number }): Promise<{
  transactionId: string;
}> {
  let stage = 'init';
  try {
    const stripe = await getServerStripe();
    if (!stripe) {
      throw throwBadRequestError('Stripe not available');
    }

    stage = 'stripe.paymentIntents.retrieve';
    const paymentIntent = await stripe.paymentIntents.retrieve(stripePaymentIntentId, {
      expand: ['payment_method'],
    });

    if (!paymentIntent || paymentIntent.status !== 'succeeded') {
      throw throwBadRequestError('Payment intent not found');
    }

    const metadata: PaymentIntentMetadataSchema =
      paymentIntent.metadata as PaymentIntentMetadataSchema;

    if (metadata.transactionId) {
      // Avoid double down on buzz
      return { transactionId: metadata.transactionId };
    }

    stage = 'getMultipliersForUser';
    const { purchasesMultiplier } = await getMultipliersForUser(userId);

    stage = 'getBuzzBulkMultiplier';
    const { totalCustomBuzz, blueBuzzAdded, bulkBuzzMultiplier } = getBuzzBulkMultiplier({
      buzzAmount: amount,
      purchasesMultiplier,
    });
    const buzzAmount = totalCustomBuzz;

    stage = 'buzzApi.transaction';
    const data = (await buzzService.createTransaction({
      amount: buzzAmount,
      fromAccountId: 0,
      toAccountId: userId,
      toAccountType: (metadata.buzzType as any) ?? 'yellow', // Default to yellow if not specified
      type: TransactionType.Purchase,
      description: `Purchase of ${amount} Buzz via Stripe. ${
        purchasesMultiplier && purchasesMultiplier > 1
          ? 'Multiplier applied due to membership. '
          : ''
      }${
        bulkBuzzMultiplier > 1 ? 'Bulk purchase bonus applied. ' : ''
      }A total of ${numberWithCommas(buzzAmount)} Buzz was added to your account.`,
      details: { ...(details ?? {}), stripePaymentIntentId },
      externalTransactionId: paymentIntent.id,
    })) as { transactionId: string };

    // Write transactionId immediately so any subsequent failure lets the retry
    // path skip the main grant via the early-return above.
    stage = 'stripe.paymentIntents.update:transactionId';
    await stripe.paymentIntents.update(stripePaymentIntentId, {
      metadata: {
        transactionId: data.transactionId,
        buzzAmountWithMultiplier: buzzAmount,
        multiplier: purchasesMultiplier,
      },
    });

    // Sub-grants use per-grant metadata flags so retries skip already-completed
    // steps. Each flag is written immediately after its grant succeeds.
    if (blueBuzzAdded > 0 && !metadata.blueBuzzGranted) {
      stage = 'buzzApi.blueBuzzReward';
      await createBuzzTransaction({
        amount: blueBuzzAdded,
        fromAccountId: 0,
        toAccountId: userId,
        toAccountType: 'blue',
        externalTransactionId: `${paymentIntent.id}-bulk-reward`,
        type: TransactionType.Purchase,
        description: `A total of ${numberWithCommas(
          blueBuzzAdded
        )} Blue Buzz was added to your account for Bulk purchase.`,
        details: { ...(details ?? {}), stripePaymentIntentId },
      });
      stage = 'stripe.paymentIntents.update:blueBuzzGranted';
      await stripe.paymentIntents.update(stripePaymentIntentId, {
        metadata: { blueBuzzGranted: 'true' },
      });
    }

    if (bulkBuzzMultiplier > 1 && !metadata.cosmeticsGranted) {
      stage = 'cosmetic.grant';
      await grantCosmetics({
        userId,
        cosmeticIds: specialCosmeticRewards.bulkBuzzRewards,
      });
      stage = 'stripe.paymentIntents.update:cosmeticsGranted';
      await stripe.paymentIntents.update(stripePaymentIntentId, {
        metadata: { cosmeticsGranted: 'true' },
      });
    }

    // 2024-12-12: Deprecated
    // await eventEngine.processPurchase({
    //   userId,
    //   amount,
    // });

    return data;
  } catch (error) {
    const err = error as Error;
    const willRetry = retry < MAX_RETRIES;
    logToAxiom(
      {
        name: 'stripe-webhook',
        type: willRetry ? 'warning' : 'error',
        stage: `completeStripeBuzzTransaction:${stage}`,
        stripePaymentIntentId,
        userId,
        amount,
        buzzType: (details as any)?.buzzType,
        retry,
        maxRetries: MAX_RETRIES,
        willRetry,
        message: `completeStripeBuzzTransaction failed at ${stage}: ${err?.message ?? String(err)}`,
        error: err?.message ?? String(err),
        stack: err?.stack,
      },
      'webhooks'
    ).catch(() => null);

    if (willRetry) {
      return completeStripeBuzzTransaction({
        amount,
        stripePaymentIntentId,
        details,
        userId,
        retry: retry + 1,
      });
    }

    throw error;
  }
}

export async function refundTransaction(
  transactionId: string,
  description?: string,
  details?: MixedObject
) {
  return buzzService.refundTransaction(transactionId, { description, details });
}

export async function createMultiAccountBuzzTransaction(
  input: CreateMultiAccountBuzzTransactionInput & { fromAccountId: number }
) {
  // Default user acc:
  input.toAccountType = input.toAccountType ?? 'yellow'; // Default to bank if not provided
  const data = await buzzService.createMultiTransaction(input);

  return createMultiAccountBuzzTransactionResponse.parse(data);
}

export async function refundMultiAccountTransaction(input: RefundMultiAccountTransactionInput) {
  const data = await buzzService.refundMultiTransaction(input);

  return refundMultiAccountTransactionResponse.parse(data);
}

export async function previewMultiAccountTransaction(input: PreviewMultiAccountTransactionInput) {
  const { fromAccountId, fromAccountTypes, amount } = input;

  const data = await buzzService.previewMultiTransaction({
    fromAccountId,
    amount,
    fromAccountTypes,
  });

  return previewMultiAccountTransactionResponse.parse(data);
}

export async function getAccountSummary({
  accountIds,
  accountType = 'yellow',
  start,
  end,
  window,
}: {
  accountIds: number | number[];
  accountType?: BuzzSpendType;
  start?: Date;
  end?: Date;
  window?: 'hour' | 'day' | 'week' | 'month' | 'year';
}) {
  if (!Array.isArray(accountIds)) accountIds = [accountIds];

  const dataRaw = await buzzService.getAccountSummary(accountType, {
    query: { accountId: accountIds, descending: false, start, end, window },
  });

  return Object.fromEntries(
    Object.entries(dataRaw).map(([accountId, { data }]) => [
      parseInt(accountId),
      data.map((d) => ({ ...d, date: new Date(d.date) })),
    ])
  );
}

/**
 * Gets the top contributors for the specified account(s).
 *
 * @param accountIds - Single account ID or array of account IDs to get contributors for
 * @param accountType - Type of account (e.g., 'User'). Defaults to 'User'
 * @param start - Optional start date to filter contributions
 * @param end - Optional end date to filter contributions
 * @param limit - Maximum number of contributors to return. Defaults to 100
 * @param all - When true, contributedBalance will be the sum of all transactions for that user.
 *              The value can be negative if the user has received more from that account than what they put in.
 *              When false, only considers positive contributions. Defaults to false
 */
export async function getTopContributors({
  accountIds,
  accountType = 'yellow',
  start,
  end,
  limit = 100,
  all = false,
}: {
  accountIds: number | number[];
  accountType?: BuzzSpendType | 'creatorProgramBank' | 'creatorProgramBankGreen';
  start?: Date;
  end?: Date;
  limit?: number;
  all?: boolean;
}) {
  if (!Array.isArray(accountIds)) accountIds = [accountIds];

  const dataRaw = await buzzService.getContributors(accountType, {
    query: { accountId: accountIds, limit, start, end, all: all || undefined },
  });

  return Object.fromEntries(
    Object.entries(dataRaw).map(([accountId, contributors]) => [
      parseInt(accountId),
      contributors.map((d) => ({ userId: d.accountId, amount: d.contributedBalance })),
    ])
  );
}

export async function pingBuzzService() {
  return buzzService.ping();
}

export async function getTransactionByExternalId(externalId: string) {
  const data = await buzzService.getTransactionByExternalId(externalId);
  if (data === null) return null;
  return getBuzzTransactionResponse.parse(data);
}

type BuzzClaimRequest = { id: string; userId: number };
type BuzzClaimDetails = {
  title: string;
  description: string;
  amount: number;
  accountType: BuzzSpendType;
  useMultiplier?: boolean;
};
export type BuzzClaimResult =
  | {
      status: 'unavailable';
      details: BuzzClaimDetails;
      reason: string;
    }
  | { status: 'available'; details: BuzzClaimDetails; claimId: string }
  | { status: 'claimed'; details: BuzzClaimDetails; claimedAt: Date };

export async function getClaimStatus({ id, userId }: BuzzClaimRequest) {
  const claimable = await dbWrite.buzzClaim.findUnique({
    where: { key: id },
  });

  const details = {
    title: claimable?.title ?? 'Unknown',
    description: claimable?.description ?? 'Unknown',
    amount: claimable?.amount ?? 0,
    accountType: BuzzTypes.toClientType(
      (claimable?.accountType ?? 'User') as BuzzApiAccountType
    ) as BuzzSpendType,
    useMultiplier: claimable?.useMultiplier ?? false,
  } as BuzzClaimDetails;

  function unavailable(reason: string) {
    return {
      status: 'unavailable',
      reason,
      details,
    } as BuzzClaimResult;
  }

  if (!claimable) return unavailable(`We couldn't find this reward`);
  if (claimable.availableStart && claimable.availableStart > new Date())
    return unavailable('This reward is not available yet');
  if (claimable.availableEnd && claimable.availableEnd < new Date())
    return unavailable('This reward is no longer available');
  if (claimable.limit && claimable.claimed > claimable.limit)
    return unavailable("This reward has reached it's claim limit");

  const query = claimable.transactionIdQuery.replace('${userId}', userId.toString());
  let transactionId: string | undefined;
  try {
    const transactionIdRows = await dbWrite.$queryRawUnsafe<{ transactionId: string }[]>(query);
    if (transactionIdRows.length === 0) return unavailable('You are not eligible for this reward');
    transactionId = transactionIdRows[0].transactionId;
    if (transactionId === undefined) throw new Error('No transaction id');
  } catch (err) {
    return unavailable(`There was a problem checking your eligibility for this reward`);
  }

  const transaction = await getTransactionByExternalId(transactionId);
  if (transaction) {
    return {
      status: 'claimed',
      details,
      claimedAt: transaction.date,
    } as BuzzClaimResult;
  }

  return {
    status: 'available',
    details,
    claimId: transactionId,
  } as BuzzClaimResult;
}

export async function claimBuzz({ id, userId }: BuzzClaimRequest) {
  const claimStatus = await getClaimStatus({ id, userId });
  if (claimStatus.status !== 'available') return claimStatus;

  const { rewardsMultiplier } = await getMultipliersForUser(userId);

  const priorTransaction = await getTransactionByExternalId(claimStatus.claimId);
  if (priorTransaction) {
    return {
      status: 'claimed',
      details: claimStatus.details,
      claimedAt: priorTransaction.date,
    } as BuzzClaimResult;
  }

  // Update the claim count
  await dbWrite.$executeRaw`
    UPDATE "BuzzClaim"
    SET claimed = claimed + 1
    WHERE key = ${id}
  `;

  // Create the transaction
  await createBuzzTransaction({
    amount: claimStatus.details.useMultiplier
      ? Math.ceil(claimStatus.details.amount * rewardsMultiplier)
      : claimStatus.details.amount,
    externalTransactionId: claimStatus.claimId,
    fromAccountId: 0,
    toAccountId: userId,
    type: TransactionType.Reward,
    description: `Claimed reward: ${claimStatus.details.title}. ${
      claimStatus.details.useMultiplier
        ? `Original amount: ${claimStatus.details.amount}. Multiplier: ${rewardsMultiplier}x`
        : ''
    }`,
    toAccountType: claimStatus.details.accountType ?? 'user',
  });

  return {
    status: 'claimed',
    details: claimStatus.details,
    claimedAt: new Date(),
  } as BuzzClaimResult;
}

type EarnPotential = {
  users: number;
  jobs: number;
  avg_job_cost: number;
  avg_ownership: number;
  total_comp: number;
  total_tips: number;
  total: number;
};
const CREATOR_COMP_PERCENT = 0.25;
const TIP_PERCENT = 0.25;

export async function getEarnPotential({ userId, username }: GetEarnPotentialSchema) {
  if (!clickhouse) return;
  if (!userId && !username) return;
  if (!userId && username) {
    const user = await getUserByUsername({ username, select: { id: true } });
    if (!user) return;
    userId = user.id;
  }

  const [potential] = await clickhouse.$query<EarnPotential>`
    WITH user_resources AS (
      SELECT
        mv.id as id,
        m.type = 'Checkpoint' as is_base_model
      FROM civitai_pg.Model m
      JOIN civitai_pg.ModelVersion mv ON mv.modelId = m.id
      WHERE m.userId = ${userId}
    ), resource_jobs AS (
      SELECT
        arrayJoin(resourcesUsed) AS modelVersionId, createdAt, cost as jobCost, jobId, userId
      FROM orchestration.jobs
      WHERE jobType IN ('TextToImageV2', 'TextToImage', 'Comfy')
        AND arrayExists(x -> x IN (SELECT id FROM user_resources), resourcesUsed)
        AND createdAt > subtractDays(now(), 30)
        AND modelVersionId NOT IN (250708, 250712, 106916) -- Exclude models that are not eligible for compensation
    ), resource_ownership AS (
      SELECT
        rj.*,
        rj.modelVersionId IN (SELECT id FROM user_resources WHERE is_base_model) as isBaseModel,
        rj.modelVersionId IN (SELECT id FROM user_resources) as isOwner
      FROM resource_jobs rj
    ), data AS (
      SELECT
        jobId,
        userId,
        CEIL(MAX(jobCost)) as job_cost,
        job_cost * ${CREATOR_COMP_PERCENT} as creator_comp,
        CEIL(job_cost * ${TIP_PERCENT}) as full_tip,
        count(modelVersionId) as resource_count,
        countIf(isOwner) as owned_resource_count,
        owned_resource_count/resource_count as owned_ratio,
        full_tip * owned_ratio as tip,
        creator_comp * if(MAX(isBaseModel) = 1, 0.25, 0) as base_model_comp,
        creator_comp * 0.75 * owned_ratio as resource_comp,
        if(MAX(isBaseModel) = 1, 0.25, 0) + 0.75 * owned_ratio as full_ratio,
        base_model_comp + resource_comp as total_comp,
        total_comp + tip as total
      FROM resource_ownership
      GROUP BY jobId, userId
    )
    SELECT
      uniq(userId) as users,
      count(jobId) as jobs,
      if(isNaN(avg(job_cost)), 0, avg(job_cost)) as avg_job_cost,
      if(isNaN(avg(full_ratio)), 0, avg(full_ratio)) as avg_ownership,
      floor(SUM(total_comp)) as total_comp,
      floor(SUM(tip)) as total_tips,
      floor(SUM(total)) as total
    FROM data;
  `;

  return potential;
}

const earnedCache = createCachedObject<{ id: number; earned: number }>({
  key: REDIS_KEYS.BUZZ.EARNED,
  idKey: 'id',
  lookupFn: async (ids) => {
    if (ids.length === 0 || !clickhouse) return {};

    const results = await clickhouse.$query<{ id: number; earned: number }>`
      SELECT
        toAccountId as id,
        SUM(amount) as earned
      FROM buzzTransactions
      WHERE (
        (type IN ('compensation')) -- Generation
        OR (type = 'purchase' AND fromAccountId != 0) -- Early Access
      )
      AND toAccountType = 'yellow'
      AND toAccountId IN (${ids})
      AND toStartOfMonth(date) = toStartOfMonth(subtractMonths(now(), 1))
      GROUP BY toAccountId;
    `;

    return Object.fromEntries(results.map((r) => [r.id, { id: r.id, earned: Number(r.earned) }]));
  },
  ttl: CacheTTL.day,
});

export async function getPoolForecast({ userId, username }: GetEarnPotentialSchema) {
  if (!clickhouse) return;
  if (!userId && !username) return;
  if (!userId && username) {
    const user = await getUserByUsername({ username, select: { id: true } });
    if (!user) return;
    userId = user.id;
  }
  if (!userId) return;

  const poolSize = await fetchThroughCache(
    REDIS_KEYS.BUZZ.POTENTIAL_POOL,
    async () => {
      const results = await clickhouse!.$query<{ balance: number }>`
        SELECT
          SUM(amount) AS balance
        FROM buzzTransactions
        WHERE toAccountType = 'yellow'
        AND (
          (type IN ('compensation')) -- Generation
          OR (type = 'purchase' AND fromAccountId != 0) -- Early Access
        )
        AND toAccountId != 0
        AND toStartOfMonth(date) = toStartOfMonth(subtractMonths(now(), 1));
    `;
      if (!results.length) return 135000000;
      return results[0].balance;
    },
    { ttl: CacheTTL.day }
  );

  const poolValue = await fetchThroughCache(
    REDIS_KEYS.BUZZ.POTENTIAL_POOL_VALUE,
    async () => {
      const results = await clickhouse!.$query<{ balance: number }>`
        SELECT
            SUM(amount) / 1000 AS balance
        FROM buzzTransactions
        WHERE toAccountType = 'yellow'
        AND type = 'purchase'
        AND fromAccountId = 0
        AND externalTransactionId NOT LIKE 'renewalBonus:%'
        AND toStartOfMonth(date) = toStartOfMonth(subtractMonths(now(), 1));
      `;
      if (!results.length || !env.CREATOR_POOL_TAXES || !env.CREATOR_POOL_PORTION) return 35000;
      const gross = results[0].balance;
      const taxesAndFees = gross * (env.CREATOR_POOL_TAXES / 100);
      const poolValue = (gross - taxesAndFees) * (env.CREATOR_POOL_PORTION / 100);
      return poolValue;
    },
    { ttl: CacheTTL.day }
  );

  const results = await earnedCache.fetch(userId);

  return {
    poolSize,
    poolValue,
    earned: results[userId]?.earned ?? 0,
  };
}

type Row = {
  modelVersionId: number;
  date: Date;
  accountType: string;
  total: number;
};

export const getDailyCompensationRewardByUser = async ({
  userId,
  date = new Date(),
  accountType,
  source = 'compensation',
}: GetDailyBuzzCompensationInput) => {
  const modelVersions = await dbRead.modelVersion.findMany({
    where: { model: { userId }, status: 'Published' },
    select: {
      id: true,
      name: true,
      model: { select: { name: true } },
    },
  });

  const hasPublishedResources = modelVersions.length > 0;
  if (!clickhouse || !modelVersions.length) return { resources: [], hasPublishedResources };
  // Capture the narrowed (non-undefined) client so the read closure below keeps the
  // type guard — TS doesn't propagate the `!clickhouse` narrowing into a callback.
  const ch = clickhouse;

  const minDate = dayjs.utc(date).startOf('day').startOf('month').toDate();
  const maxDate = dayjs.utc(date).endOf('day').endOf('month').toDate();

  const versionIds = modelVersions.map((v) => v.id);
  // A transient ClickHouse connection blip in this read (e.g. `socket hang up`) is a
  // retryable dependency outage, not a query fault — map it to a retryable 503 (so the
  // client backs off + retries) instead of the whole compensation query 500ing. A real
  // query/schema fault (non-connection CH error) still surfaces raw. Same class as the
  // #3064 New Order counter fix / #2978 / #3049.
  const generationData = await runClickHouseRead(
    () => ch.$query<Row>`
      SELECT
        date,
        modelVersionId,
        accountType,
        SUM(FLOOR(amount))::int AS total
      FROM orchestration.resourceCompensations
      WHERE date BETWEEN ${minDate} AND ${maxDate}
        AND modelVersionId IN (${versionIds})
        AND amount > 0
        AND source ${source === 'licenseFee' ? '=' : '!='} 'licenseFee'
        -- We do this weird conversion here because the DB sometimes has Yellow and sometimes User. Yellow being the alias for User.
        -- License fees can settle to cash OR buzz, so we ignore the accountType filter on that source and surface all of them together.
        AND ${
          accountType && source !== 'licenseFee'
            ? `accountType IN ('${BuzzTypes.toApiType(accountType)}', '${toPascalCase(accountType)}')`
            : '1=1'
        }
      GROUP BY modelVersionId, accountType, date
      ORDER BY date DESC, total DESC
    `,
    'Daily Buzz compensation is temporarily unavailable, please retry.'
  );

  if (!generationData.length) return { resources: [], hasPublishedResources };

  // cashData totals are in pennies — CH stores cashSettled amounts in
  // tenths-of-a-penny, so divide by 10.
  const resources = modelVersions
    .map(({ model, ...version }) => {
      const versionRows = generationData.filter((x) => x.modelVersionId === version.id);
      const buzzByDate = new Map<string, number>();
      const cashByDate = new Map<string, number>();
      for (const row of versionRows) {
        const day = dayjs(row.date).format('YYYY-MM-DD');
        if (CASH_SETTLED_ALIASES.has(row.accountType)) {
          cashByDate.set(day, (cashByDate.get(day) ?? 0) + Math.floor(row.total / 10));
        } else {
          buzzByDate.set(day, (buzzByDate.get(day) ?? 0) + row.total);
        }
      }
      const data = Array.from(buzzByDate.entries()).map(([createdAt, total]) => ({
        createdAt,
        total,
      }));
      const cashData = Array.from(cashByDate.entries()).map(([createdAt, total]) => ({
        createdAt,
        total,
      }));
      const totalSum = data.reduce((acc, x) => acc + x.total, 0);
      const cashCents = cashData.reduce((acc, x) => acc + x.total, 0);
      return {
        ...version,
        modelName: model.name,
        data,
        cashData,
        totalSum,
        cashCents,
      };
    })
    .filter((v) => v.data.length > 0 || v.cashCents > 0)
    .sort((a, b) => b.totalSum + b.cashCents - (a.totalSum + a.cashCents));

  return { resources, hasPublishedResources };
};

export async function claimWatchedAdReward({
  key,
  userId,
  ip,
}: ClaimWatchedAdRewardInput & { userId: number; ip?: string }) {
  throw new Error('claimWatchedAdReward not implemented');
  // const rewardDetails = await adWatchedReward.getUserRewardDetails(userId);
  // if (!rewardDetails) return false;

  // const awardedPercent =
  //   rewardDetails.cap && rewardDetails.awarded !== -1
  //     ? rewardDetails.awarded / rewardDetails.cap
  //     : 0;
  // if (awardedPercent >= 1) return false;

  // const token = generateSecretHash(key);
  // const match = await dbRead.adToken.findFirst({
  //   where: { token, userId },
  //   select: { expiresAt: true, createdAt: true },
  // });
  // // if token doesn't exist or is expired, it's invalid
  // if (!match || (match.expiresAt && match.expiresAt < new Date())) return false;

  // // if token was created less than 15 seconds ago, it's invalid
  // const now = new Date();
  // if (now.getTime() - match.createdAt.getTime() < 15000) return false;

  // // await adWatchedReward.apply({ token, userId }, ip);
  // await dbWrite.adToken.update({
  //   where: { token },
  //   data: { expiresAt: new Date() },
  // });

  // return true;
}

export async function getTransactionsReport({
  userId,
  ...input
}: GetTransactionsReportSchema & { userId: number }) {
  const startDate =
    input.window === 'hour'
      ? dayjs().startOf('day')
      : input.window === 'day'
      ? dayjs().startOf('day').subtract(7, 'day')
      : input.window === 'week'
      ? dayjs().startOf('day').subtract(1, 'month')
      : dayjs().startOf('day').subtract(1, 'year');
  // End date is always the start of the next day
  const endDate = dayjs().add(1, 'day').startOf('day');

  const data = await buzzService.getUserTransactionsReport(userId, {
    accountType: input.accountType ?? 'yellow',
    window: input.window,
    start: startDate.toDate(),
    end: endDate.toDate(),
  });

  return getTransactionsReportResultSchema.parse(data);
}

export async function getCounterPartyBuzzTransactions({
  accountId,
  accountType,
  counterPartyAccountId,
  counterPartyAccountType,
}: GetBuzzMovementsBetweenAccounts) {
  return withRetries(
    async () => {
      // if (isProd) logToAxiom({ type: 'buzz', id: accountId }, 'connection-testing').catch();

      return buzzService.getCounterparties<GetBuzzMovementsBetweenAccountsResponse>(accountId, {
        accountType,
        query: {
          accountId: counterPartyAccountId,
          accountType: counterPartyAccountType ?? 'yellow',
        },
      });
    },
    3,
    1500
  );
}

const providerDisplayNames: Record<string, string> = {
  nowpayments: 'NOWPayments',
  coinbase: 'Coinbase',
  emerchantpay: 'EmerchantPay',
};

export const grantBuzzPurchase = async ({
  amount,
  userId,
  externalTransactionId,
  description,
  accountType,
  provider,
  ...data
}: {
  amount: number;
  userId: number;
  externalTransactionId: string;
  description?: string;
  accountType?: BuzzAccountType;
  provider?: string;
} & MixedObject) => {
  const { purchasesMultiplier } = await getMultipliersForUser(userId);
  const { blueBuzzAdded, totalCustomBuzz, bulkBuzzMultiplier } = getBuzzBulkMultiplier({
    buzzAmount: amount,
    purchasesMultiplier,
  });

  const displayProvider = provider ? providerDisplayNames[provider] ?? provider : undefined;

  // Give user the buzz assuming it hasn't been given
  const { transactionId } = await createBuzzTransaction({
    fromAccountId: 0,
    toAccountId: userId,
    toAccountType: accountType ?? 'yellow',
    amount: totalCustomBuzz,
    type: TransactionType.Purchase,
    externalTransactionId,
    description:
      description ??
      `Purchase of ${numberWithCommas(amount)} Buzz${
        displayProvider ? ` via ${displayProvider}` : ''
      }. ${
        purchasesMultiplier && purchasesMultiplier > 1
          ? 'Multiplier applied due to membership. '
          : ''
      }A total of ${numberWithCommas(totalCustomBuzz)} Buzz was added to your account.`,
    details: {
      ...data,
    },
  });

  if (!transactionId) {
    throw new Error('Failed to create Buzz transaction');
  }

  if (blueBuzzAdded > 0) {
    await createBuzzTransaction({
      amount: blueBuzzAdded,
      fromAccountId: 0,
      toAccountId: userId,
      toAccountType: 'blue',
      externalTransactionId: `${transactionId}-bulk-reward`,
      type: TransactionType.Purchase,
      description: `A total of ${numberWithCommas(
        blueBuzzAdded
      )} Blue Buzz was added to your account for Bulk purchase.`,
      details: {
        ...data,
      },
    });
  }

  if (bulkBuzzMultiplier > 1) {
    const cosmeticIds = specialCosmeticRewards.bulkBuzzRewards;
    await grantCosmetics({
      userId,
      cosmeticIds,
    });
  }

  return transactionId;
};

export async function getMultiAccountTransactionsByPrefix(externalTransactionIdPrefix: string) {
  const data = await buzzService.listMultiTransactions({ externalTransactionIdPrefix });

  return data.map((item) => ({
    ...item,
    accountType: BuzzTypes.toClientType(item.accountType),
  }));
}

export async function getAccountsBalances({
  accountIds,
  accountTypes,
}: {
  accountIds: number[];
  accountTypes: BuzzAccountType[];
}) {
  if (accountIds.length === 0) return [];
  if (accountTypes.length === 0) return [];

  const data = await buzzService.getAccountBalances({
    accountId: accountIds,
    accountType: accountTypes,
  });

  return data.map((item) => ({
    ...item,
    accountType: BuzzTypes.toClientType(item.accountType),
  }));
}
