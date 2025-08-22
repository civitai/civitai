import { TRPCError } from '@trpc/server';
import dayjs from '~/shared/utils/dayjs';
import { v4 as uuid } from 'uuid';
import { isDev } from '~/env/other';
import { env } from '~/env/server';
import { clickhouse } from '~/server/clickhouse/client';
import { CacheTTL, specialCosmeticRewards } from '~/server/common/constants';
import { NotificationCategory } from '~/server/common/enums';
import { dbRead, dbWrite } from '~/server/db/client';
import { userMultipliersCache } from '~/server/redis/caches';
import { REDIS_KEYS } from '~/server/redis/client';
import type {
  BuzzAccountType,
  ClaimWatchedAdRewardInput,
  CompleteStripeBuzzPurchaseTransactionInput,
  CreateBuzzTransactionInput,
  GetBuzzMovementsBetweenAccounts,
  GetBuzzMovementsBetweenAccountsResponse,
  GetBuzzTransactionResponse,
  GetDailyBuzzCompensationInput,
  GetEarnPotentialSchema,
  GetTransactionsReportResultSchema,
  GetTransactionsReportSchema,
  GetUserBuzzAccountResponse,
  GetUserBuzzAccountSchema,
  GetUserBuzzTransactionsResponse,
  GetUserBuzzTransactionsSchema,
} from '~/server/schema/buzz.schema';
import { getUserBuzzTransactionsResponse, TransactionType } from '~/server/schema/buzz.schema';
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
// import { adWatchedReward } from '~/server/rewards';

type AccountType = 'User';

export async function getUserBuzzAccount({ accountId, accountType }: GetUserBuzzAccountSchema) {
  if (!env.BUZZ_ENDPOINT) throw new Error('Missing BUZZ_ENDPOINT env var');

  return withRetries(
    async () => {
      // if (isProd) logToAxiom({ type: 'buzz', id: accountId }, 'connection-testing').catch();
      const response = await fetch(
        `${env.BUZZ_ENDPOINT as string}/account/${accountType ? `${accountType}/` : ''}${accountId}`
      );
      if (!response.ok) {
        switch (response.status) {
          case 400:
            throw throwBadRequestError();
          case 404:
            throw new TRPCError({ code: 'NOT_FOUND', message: 'Account not found' });
          default:
            throw new TRPCError({
              code: 'INTERNAL_SERVER_ERROR',
              message: 'An unexpected error ocurred, please try again later',
            });
        }
      }

      const data: GetUserBuzzAccountResponse = await response.json();
      return data;
    },
    3,
    1500
  );
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
  if (!env.BUZZ_ENDPOINT) throw new Error('Missing BUZZ_ENDPOINT env var');

  const queryString = QS.stringify({
    ...query,
    start: query.start?.toISOString(),
    end: query.end?.toISOString(),
    cursor: query.cursor?.toISOString(),
    descending: true,
  });

  const response = await fetch(
    `${env.BUZZ_ENDPOINT}/account/${
      accountType ? `${accountType}/` : ''
    }${accountId}/transactions?${queryString}`
  );

  if (!response.ok) {
    switch (response.status) {
      case 400:
        throw throwBadRequestError();
      case 404:
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Account not found' });
      default:
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'An unexpected error ocurred, please try again later',
        });
    }
  }

  // Parse incoming data
  const data: GetUserBuzzTransactionsResponse = await response.json();
  const { cursor, transactions } = getUserBuzzTransactionsResponse.parse(data);

  // Return early if no transactions
  if (transactions.length === 0) return { cursor, transactions: [] };

  // Remove duplicate user ids
  const toUserIds = new Set(
    transactions.filter((t) => t.toAccountType === 'user').map((t) => t.toAccountId)
  );
  const fromUserIds = new Set(
    transactions.filter((t) => t.fromAccountType === 'user').map((t) => t.fromAccountId)
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
  if (!env.BUZZ_ENDPOINT) throw new Error('Missing BUZZ_ENDPOINT env var');

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

  const account = await getUserBuzzAccount({
    accountId: payload.fromAccountId,
    accountType: payload.fromAccountType,
  });

  // 0 is the bank so technically, it always has funding.
  if (
    payload.fromAccountId !== 0 &&
    payload.fromAccountType !== 'creatorprogrambank' &&
    (account.balance ?? 0) < amount
  ) {
    throw throwInsufficientFundsError(insufficientFundsErrorMsg);
  }

  const body = JSON.stringify({
    ...payload,
    details: {
      ...(details ?? {}),
      entityId: entityId ?? details?.entityId,
      entityType: entityType ?? details?.entityType,
    },
    amount,
    toAccountId,
  });

  const response = await fetch(`${env.BUZZ_ENDPOINT}/transaction`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
  });

  if (!response.ok) {
    if (isDev) {
      console.error('Failed to create Buzz transaction', response);
    }
    switch (response.status) {
      case 400:
        throw throwBadRequestError('Invalid transaction');
      case 409:
        throw throwBadRequestError('There is a conflict with the transaction');
      default:
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'An unexpected error ocurred, please try again later',
        });
    }
  }

  const data: { transactionId: string | null } = await response.json();

  return data;
}

export async function upsertBuzzTip({
  amount,
  entityId,
  entityType,
  fromAccountId,
  toAccountId,
  description,
}: Pick<CreateBuzzTransactionInput, 'amount' | 'toAccountId' | 'description'> & {
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
  if (!env.BUZZ_ENDPOINT) throw new Error('Missing BUZZ_ENDPOINT env var');
  // Protect against transactions that are not valid. A transaction with from === to
  // breaks the entire request.
  const validTransactions = transactions.filter(
    (t) =>
      t.toAccountId !== undefined &&
      (t.fromAccountId !== t.toAccountId || t.fromAccountType === 'cashpending') &&
      t.amount > 0
  );
  const body = JSON.stringify(validTransactions);
  const response = await fetch(`${env.BUZZ_ENDPOINT}/transactions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
  });

  if (!response.ok) {
    switch (response.status) {
      case 400:
        throw throwBadRequestError('Invalid transaction');
      case 409:
        throw throwBadRequestError('There is a conflict with the transaction');
      default:
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'An unexpected error ocurred, please try again later',
        });
    }
  }

  const data: { transactions: { transactionId: string }[] } = await response.json();
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
  if (!env.BUZZ_ENDPOINT) throw new Error('Missing BUZZ_ENDPOINT env var');

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
      type: TransactionType.Purchase,
      description: `Purchase of ${amount} Buzz. ${
        purchasesMultiplier && purchasesMultiplier > 1
          ? 'Multiplier applied due to membership. '
          : ''
      }A total of ${buzzAmount} Buzz was added to your account.`,
      details: { ...(details ?? {}), stripePaymentIntentId },
      externalTransactionId: paymentIntent.id,
    });

    const response = await fetch(`${env.BUZZ_ENDPOINT}/transaction`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    });

    if (!response.ok) {
      switch (response.status) {
        case 400:
          throw throwBadRequestError('Invalid transaction');
        case 409:
          throw throwBadRequestError('There is a conflict with the transaction');
        default:
          throw new TRPCError({
            code: 'INTERNAL_SERVER_ERROR',
            message: 'An unexpected error ocurred, please try again later',
          });
      }
    }

    const data: { transactionId: string } = await response.json();

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
  if (!env.BUZZ_ENDPOINT) throw new Error('Missing BUZZ_ENDPOINT env var');

  const body = JSON.stringify({
    description,
    details,
  });

  const response = await fetch(`${env.BUZZ_ENDPOINT}/transactions/${transactionId}/refund`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
  });

  // TODO.buzz make this reusable
  if (!response.ok) {
    switch (response.status) {
      case 400:
        throw throwBadRequestError('Invalid transaction');
      case 409:
        throw throwBadRequestError('There is a conflict with the transaction');
      default:
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'An unexpected error ocurred, please try again later',
        });
    }
  }

  const resp: { transactionId: string } = await response.json();

  return resp;
}

type AccountSummaryRecord = {
  accountId: number;
  date: Date;
  balance: number;
  lifetimeBalance: number;
};

export async function getAccountSummary({
  accountIds,
  accountType = 'User',
  start,
  end,
  window,
}: {
  accountIds: number | number[];
  accountType?: AccountType;
  start?: Date;
  end?: Date;
  window?: 'hour' | 'day' | 'week' | 'month' | 'year';
}) {
  if (!env.BUZZ_ENDPOINT) throw new Error('Missing BUZZ_ENDPOINT env var');

  if (!Array.isArray(accountIds)) accountIds = [accountIds];
  const queryParams: [string, string][] = [['descending', 'false']];
  if (start) queryParams.push(['start', stripTime(start)]);
  if (end) queryParams.push(['end', stripTime(end)]);
  if (window) queryParams.push(['window', window]);
  for (const accountId of accountIds) queryParams.push(['accountId', accountId.toString()]);

  const response = await fetch(
    `${env.BUZZ_ENDPOINT}/account/${accountType}/summary?${new URLSearchParams(
      queryParams
    ).toString()}`
  );

  if (!response.ok) throw new Error('Failed to fetch account summary');

  const dataRaw = (await response.json()) as Record<
    string,
    { data: AccountSummaryRecord[]; cursor: null }
  >;

  return Object.fromEntries(
    Object.entries(dataRaw).map(([accountId, { data }]) => [
      parseInt(accountId),
      data.map((d) => ({ ...d, date: new Date(d.date) })),
    ])
  );
}

export async function getTopContributors({
  accountIds,
  accountType = 'User',
  start,
  end,
  limit = 100,
}: {
  accountIds: number | number[];
  accountType?: AccountType;
  start?: Date;
  end?: Date;
  limit?: number;
}) {
  if (!env.BUZZ_ENDPOINT) throw new Error('Missing BUZZ_ENDPOINT env var');

  if (!Array.isArray(accountIds)) accountIds = [accountIds];
  const queryParams: [string, string][] = [['limit', limit.toString()]];
  if (start) queryParams.push(['start', start.toISOString()]);
  if (end) queryParams.push(['end', end.toISOString()]);
  for (const accountId of accountIds) queryParams.push(['accountId', accountId.toString()]);

  const response = await fetch(
    `${env.BUZZ_ENDPOINT}/account/${accountType}/contributors?${new URLSearchParams(
      queryParams
    ).toString()}`
  );

  if (!response.ok) throw new Error('Failed to fetch top contributors');

  const dataRaw = (await response.json()) as Record<
    string,
    { accountType: AccountType; accountId: number; contributedBalance: number }[]
  >;

  return Object.fromEntries(
    Object.entries(dataRaw).map(([accountId, contributors]) => [
      parseInt(accountId),
      contributors.map((d) => ({ userId: d.accountId, amount: d.contributedBalance })),
    ])
  );
}

export async function pingBuzzService() {
  if (!env.BUZZ_ENDPOINT) throw new Error('Missing BUZZ_ENDPOINT env var');

  try {
    const response = await fetch(`${env.BUZZ_ENDPOINT}`, { signal: AbortSignal.timeout(1000) });
    return response.ok;
  } catch (error) {
    console.log('Failed to ping Buzz service');
    console.error(error);
    return false;
  }
}

export async function getTransactionByExternalId(externalId: string) {
  if (!env.BUZZ_ENDPOINT) throw new Error('Missing BUZZ_ENDPOINT env var');

  const response = await fetch(`${env.BUZZ_ENDPOINT}/transactions/${externalId}`);
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
  const transaction: GetBuzzTransactionResponse = await response.json();
  return transaction;
}

type BuzzClaimRequest = { id: string; userId: number };
type BuzzClaimDetails = {
  title: string;
  description: string;
  amount: number;
  accountType: BuzzAccountType;
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
    accountType: claimable?.accountType ?? 'user',
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
      AND toAccountType = 'user'
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
        WHERE toAccountType = 'user'
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
        WHERE toAccountType = 'user'
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

type Row = { modelVersionId: number; date: Date; comp: number; tip: number; total: number };

export const getDailyCompensationRewardByUser = async ({
  userId,
  date = new Date(),
}: GetDailyBuzzCompensationInput) => {
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

  const generationData = await clickhouse.$query<Row>`
    WITH user_resources AS (
      SELECT
        mv.id as id
      FROM civitai_pg.Model m
      JOIN civitai_pg.ModelVersion mv ON mv.modelId = m.id
      WHERE m.userId = ${userId}
    )
    SELECT DISTINCT
      date,
      modelVersionId,
      comp,
      tip,
      total
    FROM buzz_resource_compensation
    WHERE modelVersionId IN (SELECT id FROM user_resources)
    AND date BETWEEN ${minDate} AND ${maxDate}
    ORDER BY date DESC, total DESC;
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
    start: startDate.format('YYYY-MM-DD'),
    end: endDate.format('YYYY-MM-DD'),
  });

  const response = await fetch(
    `${env.BUZZ_ENDPOINT as string}/user/${userId}/transactions/report?${query}`
  );

  if (!response.ok) {
    switch (response.status) {
      case 400:
        throw throwBadRequestError();
      case 404:
        throw new TRPCError({ code: 'NOT_FOUND', message: 'User not found' });
      default:
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'An unexpected error ocurred, please try again later',
        });
    }
  }

  const data = (await response.json()) as GetTransactionsReportResultSchema;

  return data.map((record) => ({
    ...record,
    date: formatDate(record.date, 'YYYY-MM-DDTHH:mm:ss', true),
  }));
}

export async function getCounterPartyBuzzTransactions({
  accountId,
  accountType,
  counterPartyAccountId,
  counterPartyAccountType,
}: GetBuzzMovementsBetweenAccounts) {
  if (!env.BUZZ_ENDPOINT) throw new Error('Missing BUZZ_ENDPOINT env var');

  return withRetries(
    async () => {
      // if (isProd) logToAxiom({ type: 'buzz', id: accountId }, 'connection-testing').catch();

      const queryString = QS.stringify({
        accountId: counterPartyAccountId,
        accountType: counterPartyAccountType ?? 'user',
      });

      const response = await fetch(
        `${env.BUZZ_ENDPOINT as string}/account/${
          accountType ? `${accountType}/` : ''
        }${accountId}/counterparties?${queryString}`,
        {}
      );
      if (!response.ok) {
        switch (response.status) {
          case 400:
            throw throwBadRequestError();
          case 404:
            throw new TRPCError({ code: 'NOT_FOUND', message: 'Account not found' });
          default:
            throw new TRPCError({
              code: 'INTERNAL_SERVER_ERROR',
              message: 'An unexpected error ocurred, please try again later',
            });
        }
      }

      const data: GetBuzzMovementsBetweenAccountsResponse = await response.json();
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
  ...data
}: {
  amount: number;
  userId: number;
  externalTransactionId: string;
  description?: string;
} & MixedObject) => {
  const { purchasesMultiplier } = await getMultipliersForUser(userId);
  const { blueBuzzAdded, totalYellowBuzz, bulkBuzzMultiplier } = getBuzzBulkMultiplier({
    buzzAmount: amount,
    purchasesMultiplier,
  });

  // Give user the buzz assuming it hasn't been given
  const { transactionId } = await createBuzzTransaction({
    fromAccountId: 0,
    toAccountId: userId,
    amount: totalYellowBuzz,
    type: TransactionType.Purchase,
    externalTransactionId,
    description:
      description ??
      `Purchase of ${amount} Buzz. ${
        purchasesMultiplier && purchasesMultiplier > 1
          ? 'Multiplier applied due to membership. '
          : ''
      }A total of ${numberWithCommas(totalYellowBuzz)} Buzz was added to your account.`,
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
      toAccountType: 'generation',
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
