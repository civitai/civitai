import { TRPCError } from '@trpc/server';
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
  GetUserBuzzTransactionsResponse,
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
import { BuzzTypes, buzzSpendTypes, TransactionType } from '~/shared/constants/buzz.constants';
import type { PaymentIntentMetadataSchema } from '~/server/schema/stripe.schema';
import { createNotification } from '~/server/services/notification.service';
import { createCachedObject, fetchThroughCache } from '~/server/utils/cache-helpers';
import {
  throwBadRequestError,
  throwInsufficientFundsError,
  withRetries,
} from '~/server/utils/errorHandling';
import { getServerStripe } from '~/server/utils/get-server-stripe';
import { formatDate, stripTime } from '~/utils/date-helpers';
import { QS } from '~/utils/qs';
import { getUserByUsername, getUsers } from './user.service';
import { numberWithCommas } from '~/utils/number-helpers';
import { grantCosmetics } from '~/server/services/cosmetic.service';
import { getBuzzBulkMultiplier } from '~/server/utils/buzz-helpers';
import { isDev } from '~/env/other';
import { toPascalCase } from '~/utils/string-helpers';
// import type { BuzzAccountType as PrismaBuzzAccountType } from '~/shared/utils/prisma/enums';
// import { adWatchedReward } from '~/server/rewards';

type AccountType = 'User' | 'CreatorProgramBank' | 'CashPending' | 'CashSettled';

function baseEndpoint() {
  if (!env.BUZZ_ENDPOINT) throw new Error('Missing BUZZ_ENDPOINT env var');
  return env.BUZZ_ENDPOINT;
}

async function buzzApiFetch(urlPart: string, init?: RequestInit | undefined) {
  return withRetries(async () => {
    const url = `${baseEndpoint()}${urlPart}`;
    const response = await fetch(url, init);
    if (!response.ok) {
      if (isDev) {
        console.log({ url, status: response.status, statusText: response.statusText });
      }
      switch (response.status) {
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
    }

    return await response.json();
  });
}

type BuzzAccountsResponse<T extends BuzzAccountType = BuzzAccountType> = Record<T, number>;
type BuzzAccountResponse = {
  id: number;
  balance: number;
  lifetimeBalance: number;
};

async function getUserBuzzAccountByAccountId(accountId: number): Promise<BuzzAccountResponse> {
  return buzzApiFetch(`/account/${accountId}`);
}

async function getUserBuzzAccountByAccountType(
  accountId: number,
  accountType: BuzzAccountType
): Promise<BuzzAccountResponse> {
  return buzzApiFetch(`/account/${BuzzTypes.toApiType(accountType)}/${accountId}`);
}

export async function getUserBuzzAccountByAccountTypes<T extends BuzzAccountType>(
  accountId: number,
  accountTypes: T[]
): Promise<BuzzAccountsResponse<T>> {
  const data: Record<string, number> = await buzzApiFetch(
    `/user/${accountId}/accounts?${accountTypes
      .map((t) => `accountType=${BuzzTypes.toApiType(t)}`)
      .join('&')}`
  );
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

export async function getMultipliersForUser(userId: number, refresh = false) {
  if (refresh) await deleteMultipliersForUserCache(userId);

  const multipliers = await getMultipliersForUserCache([userId]);
  return multipliers[userId] ?? { purchasesMultiplier: 1, rewardsMultiplier: 1, userId };
}

export function deleteMultipliersForUserCache(userId: number) {
  return userMultipliersCache.bust(userId);
}

export async function getUserBuzzTransactions({
  accountId,
  accountType,
  ...query
}: GetUserBuzzTransactionsSchema & { accountId: number; accountType?: BuzzAccountType }) {
  const queryString = QS.stringify({
    ...query,
    start: query.start?.toISOString(),
    end: query.end?.toISOString(),
    cursor: query.cursor?.toISOString(),
    descending: true,
  });

  // Parse incoming data
  const data: GetUserBuzzTransactionsResponse = await buzzApiFetch(
    `/account/${
      accountType ? `${BuzzTypes.toApiType(accountType)}/` : ''
    }${accountId}/transactions?${queryString}`
  );

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

  const body = JSON.stringify(
    BuzzTypes.getApiTransaction({
      ...payload,
      details: {
        ...(details ?? {}),
        entityId: entityId ?? details?.entityId,
        entityType: entityType ?? details?.entityType,
      },
      amount,
      toAccountId,
    })
  );

  const data: { transactionId: string | null } = await buzzApiFetch('/transaction', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
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
  const validTransactions = transactions
    .map((t) => BuzzTypes.getApiTransaction(t))
    .filter(
      (t) =>
        t.toAccountId !== undefined &&
        (t.fromAccountId !== t.toAccountId || t.fromAccountType === 'cashPending') &&
        t.amount > 0
    );
  const body = JSON.stringify(validTransactions);

  const data: { transactions: { transactionId: string }[] } = await buzzApiFetch(`/transactions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
  });

  return data;
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
  try {
    const stripe = await getServerStripe();
    if (!stripe) {
      throw throwBadRequestError('Stripe not available');
    }

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

    const { purchasesMultiplier } = await getMultipliersForUser(userId);
    const buzzAmount = Math.ceil(amount * (purchasesMultiplier ?? 1));

    const body = JSON.stringify({
      amount: buzzAmount,
      fromAccountId: 0,
      toAccountId: userId,
      toAccountType: (metadata.buzzType as any) ?? 'yellow', // Default to yellow if not specified
      type: TransactionType.Purchase,
      description: `Purchase of ${amount} Buzz. ${
        purchasesMultiplier && purchasesMultiplier > 1
          ? 'Multiplier applied due to membership. '
          : ''
      }A total of ${buzzAmount} Buzz was added to your account.`,
      details: { ...(details ?? {}), stripePaymentIntentId },
      externalTransactionId: paymentIntent.id,
    });

    const data: { transactionId: string } = await buzzApiFetch(`/transaction`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    });

    // Update the payment intent with the transaction id
    // A payment intent without a transaction ID can be tied to a DB failure delivering buzz.
    await stripe.paymentIntents.update(stripePaymentIntentId, {
      metadata: {
        transactionId: data.transactionId,
        buzzAmountWithMultiplier: buzzAmount,
        multiplier: purchasesMultiplier,
      },
    });

    // 2024-12-12: Deprecated
    // await eventEngine.processPurchase({
    //   userId,
    //   amount,
    // });

    return data;
  } catch (error) {
    if (retry < MAX_RETRIES) {
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
  const body = JSON.stringify({
    description,
    details,
  });

  const data: { transactionId: string } = await buzzApiFetch(
    `/transactions/${transactionId}/refund`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    }
  );

  return data;
}

export async function createMultiAccountBuzzTransaction(
  input: CreateMultiAccountBuzzTransactionInput & { fromAccountId: number }
) {
  // Default user acc:
  input.toAccountType = input.toAccountType ?? 'yellow'; // Default to bank if not provided
  const body = JSON.stringify(BuzzTypes.getApiTransaction(input));

  const data = await buzzApiFetch(`/multi-transactions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
  });

  return createMultiAccountBuzzTransactionResponse.parse(data);
}

export async function refundMultiAccountTransaction(input: RefundMultiAccountTransactionInput) {
  const body = JSON.stringify(input);

  const data = await buzzApiFetch(`/multi-transactions/refund`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
  });

  return refundMultiAccountTransactionResponse.parse(data);
}

export async function previewMultiAccountTransaction(input: PreviewMultiAccountTransactionInput) {
  const { fromAccountId, fromAccountTypes, amount } = input;

  const queryParams = new URLSearchParams({
    fromAccountId: fromAccountId.toString(),
    amount: amount.toString(),
  });

  // Add multiple fromAccountTypes parameters
  fromAccountTypes.forEach((accountType) => {
    queryParams.append('fromAccountTypes', BuzzTypes.toApiType(accountType));
  });

  const data = await buzzApiFetch(`/multi-transactions/preview?${queryParams.toString()}`);

  return previewMultiAccountTransactionResponse.parse(data);
}

type AccountSummaryRecord = {
  accountId: number;
  date: Date;
  balance: number;
  lifetimeBalance: number;
};

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
  const queryParams: [string, string][] = [['descending', 'false']];
  if (start) queryParams.push(['start', stripTime(start)]);
  if (end) queryParams.push(['end', stripTime(end)]);
  if (window) queryParams.push(['window', window]);
  for (const accountId of accountIds) queryParams.push(['accountId', accountId.toString()]);

  const dataRaw: Record<string, { data: AccountSummaryRecord[]; cursor: null }> =
    await buzzApiFetch(
      `/account/${BuzzTypes.toApiType(accountType)}/summary?${new URLSearchParams(
        queryParams
      ).toString()}`
    );

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
  const queryParams: [string, string][] = [['limit', limit.toString()]];
  if (start) queryParams.push(['start', start.toISOString()]);
  if (end) queryParams.push(['end', end.toISOString()]);
  if (all) queryParams.push(['all', 'true']);
  for (const accountId of accountIds) queryParams.push(['accountId', accountId.toString()]);

  const dataRaw: Record<
    string,
    { accountType: BuzzApiAccountType; accountId: number; contributedBalance: number }[]
  > = await buzzApiFetch(
    `/account/${BuzzTypes.toApiType(accountType)}/contributors?${new URLSearchParams(
      queryParams
    ).toString()}`
  );

  return Object.fromEntries(
    Object.entries(dataRaw).map(([accountId, contributors]) => [
      parseInt(accountId),
      contributors.map((d) => ({ userId: d.accountId, amount: d.contributedBalance })),
    ])
  );
}

export async function pingBuzzService() {
  try {
    const response = await fetch(`${baseEndpoint()}`, { signal: AbortSignal.timeout(1000) });
    return response.ok;
  } catch (error) {
    console.log('Failed to ping Buzz service');
    console.error(error);
    return false;
  }
}

export async function getTransactionByExternalId(externalId: string) {
  const response = await fetch(`${baseEndpoint()}/transactions/${externalId}`);
  if (!response.ok) {
    switch (response.status) {
      case 404:
        return null;
      default:
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'An unexpected error ocurred, please try again later',
        });
    }
  }
  const data = await response.json();
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

type Row = { modelVersionId: number; date: Date; total: number };

export const getDailyCompensationRewardByUser = async ({
  userId,
  date = new Date(),
  accountType,
}: GetDailyBuzzCompensationInput) => {
  // TODO: We need to update this to use the new clickhouse table.
  const modelVersions = await dbRead.modelVersion.findMany({
    where: { model: { userId }, status: 'Published' },
    select: {
      id: true,
      name: true,
      model: { select: { name: true } },
    },
  });

  if (!clickhouse || !modelVersions.length) return [];

  const minDate = dayjs.utc(date).startOf('day').startOf('month').toDate();
  const maxDate = dayjs.utc(date).endOf('day').endOf('month').toDate();

  // TODO.resourceCompensations: we should use the new `resourceCompensations` table instead of this,
  // but we need to migrate the data first, otherwise, this data makes no sense. After 1 month, we can just migrate.
  const generationData = await clickhouse.$query<Row>`
    WITH user_resources AS (
      SELECT
        mv.id as id
      FROM civitai_pg.Model m
      JOIN civitai_pg.ModelVersion mv ON mv.modelId = m.id
      WHERE m.userId = ${userId}
    )
    SELECT
      date,
      modelVersionId,
	    MAX(FLOOR(amount))::int AS total
    FROM orchestration.resourceCompensations
    WHERE date BETWEEN ${minDate} AND ${maxDate}
      AND modelVersionId IN (SELECT id FROM user_resources)
      AND amount > 0
      -- We do this weird conversion here because the DB sometimes has Yellow and sometimes User. Yellow being the alias for User.
      AND ${
        accountType
          ? `accountType IN ('${BuzzTypes.toApiType(accountType)}', '${toPascalCase(accountType)}')`
          : '1=1'
      }
    GROUP BY modelVersionId, date
    ORDER BY date DESC, total DESC
  `;

  if (!generationData.length) return [];

  return (
    modelVersions
      .map(({ model, ...version }) => {
        const resourceData = generationData
          .filter((x) => x.modelVersionId === version.id)
          .map((resource) => ({
            createdAt: dayjs(resource.date).format('YYYY-MM-DD'),
            total: resource.total,
          }));

        const totalSum = resourceData.reduce((acc, x) => acc + x.total, 0);
        return { ...version, modelName: model.name, data: resourceData, totalSum };
      })
      .filter((v) => v.data.length > 0)
      // Pre-sort by most buzz
      .sort((a, b) => b.totalSum - a.totalSum)
  );
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

  const query = QS.stringify({
    ...input,
    accountType: BuzzTypes.toApiType(input.accountType ?? 'yellow'),
    start: startDate.format('YYYY-MM-DD'),
    end: endDate.format('YYYY-MM-DD'),
  });

  const data = await buzzApiFetch(`/user/${userId}/transactions/report?${query}`);

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

      const queryString = QS.stringify({
        accountId: counterPartyAccountId,
        accountType: BuzzTypes.toApiType(counterPartyAccountType ?? 'yellow'),
      });

      const data: GetBuzzMovementsBetweenAccountsResponse = await buzzApiFetch(
        `/account/${
          accountType ? `${BuzzTypes.toApiType(accountType)}/` : ''
        }${accountId}/counterparties?${queryString}`,
        {}
      );
      return data;
    },
    3,
    1500
  );
}

export const grantBuzzPurchase = async ({
  amount,
  userId,
  externalTransactionId,
  description,
  accountType,
  ...data
}: {
  amount: number;
  userId: number;
  externalTransactionId: string;
  description?: string;
  accountType?: BuzzAccountType;
} & MixedObject) => {
  const { purchasesMultiplier } = await getMultipliersForUser(userId);
  const { blueBuzzAdded, totalCustomBuzz, bulkBuzzMultiplier } = getBuzzBulkMultiplier({
    buzzAmount: amount,
    purchasesMultiplier,
  });

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
      `Purchase of ${amount} Buzz. ${
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
  const queryParams = new URLSearchParams({
    externalTransactionIdPrefix,
  });

  const data: {
    transactionId: string;
    externalTransactionId: string;
    accountType: BuzzApiAccountType;
    accountId: number;
    amount: number;
  }[] = await buzzApiFetch(`/multi-transactions?${queryParams.toString()}`);

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
  const queryParams: [string, string][] = [];
  if (accountIds.length === 0) return [];
  if (accountTypes.length === 0) return [];

  accountIds.forEach((id) => queryParams.push(['accountId', id.toString()]));
  accountTypes.forEach((type) => queryParams.push(['accountType', BuzzTypes.toApiType(type)]));
  const queryString = new URLSearchParams(queryParams);

  const data: {
    accountId: number;
    accountType: BuzzApiAccountType;
    balance: number;
  }[] = await buzzApiFetch(`/account-balances?${queryString.toString()}`);

  return data.map((item) => ({
    ...item,
    accountType: BuzzTypes.toClientType(item.accountType),
  }));
}
