import { TRPCError } from '@trpc/server';
import { env } from '~/env/server.mjs';
import { dbRead, dbWrite } from '~/server/db/client';
import { eventEngine } from '~/server/events';
import { userMultipliersCache } from '~/server/redis/caches';
import {
  BuzzAccountType,
  CompleteStripeBuzzPurchaseTransactionInput,
  CreateBuzzTransactionInput,
  GetBuzzTransactionResponse,
  GetUserBuzzAccountResponse,
  GetUserBuzzAccountSchema,
  getUserBuzzTransactionsResponse,
  GetUserBuzzTransactionsResponse,
  GetUserBuzzTransactionsSchema,
  TransactionType,
} from '~/server/schema/buzz.schema';
import { PaymentIntentMetadataSchema } from '~/server/schema/stripe.schema';
import { createNotification } from '~/server/services/notification.service';
import {
  throwBadRequestError,
  throwInsufficientFundsError,
  withRetries,
} from '~/server/utils/errorHandling';
import { getServerStripe } from '~/server/utils/get-server-stripe';
import { stripTime } from '~/utils/date-helpers';
import { QS } from '~/utils/qs';
import { getUsers } from './user.service';

type AccountType = 'User';

export async function getUserBuzzAccount({ accountId, accountType }: GetUserBuzzAccountSchema) {
  return withRetries(
    async () => {
      const response = await fetch(
        `${env.BUZZ_ENDPOINT}/account/${accountType ? `${accountType}/` : ''}${accountId}`
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
  return multipliers[userId];
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
    transactions.filter((t) => t.toAccountType === 'User').map((t) => t.toAccountId)
  );
  const fromUserIds = new Set(
    transactions.filter((t) => t.fromAccountType === 'User').map((t) => t.fromAccountId)
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
    const [{ userId } = { userId: undefined }] = await dbRead.$queryRawUnsafe<
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
    throw throwBadRequestError('You cannot send buzz to the same account');
  }

  const account = await getUserBuzzAccount({
    accountId: payload.fromAccountId,
    accountType: payload.fromAccountType,
  });

  // 0 is the bank so technically, it always has funding.
  if (payload.fromAccountId !== 0 && (account.balance ?? 0) < amount) {
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

  // TODO.transaction - move this outside of transaction
  if (payload.type === TransactionType.Tip && toAccountId !== 0) {
    const fromUser = await dbRead.user.findUnique({
      where: { id: payload.fromAccountId },
      select: { username: true },
    });

    await createNotification({
      type: 'tip-received',
      userId: toAccountId,
      category: 'Buzz',
      details: {
        amount: amount,
        user: fromUser?.username,
        fromUserId: payload.fromAccountId,
        message: payload.description,
        entityId,
        entityType,
      },
    });
  }

  if (entityId && entityType) {
    // Store this action in the DB:
    const existingRecord = await dbRead.buzzTip.findUnique({
      where: {
        entityType_entityId_fromUserId: {
          entityId,
          entityType,
          fromUserId: payload.fromAccountId,
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
            fromUserId: payload.fromAccountId,
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
          fromUserId: payload.fromAccountId,
        },
      });
    }
  }

  const data: { transactionId: string } = await response.json();

  return data;
}

export async function createBuzzTransactionMany(
  transactions: (CreateBuzzTransactionInput & {
    fromAccountId: number;
    externalTransactionId: string;
  })[]
) {
  // Protect against transactions that are not valid. A transaction with from === to
  // breaks the entire request.
  const validTransactions = transactions.filter(
    (t) => t.toAccountId !== undefined && t.fromAccountId !== t.toAccountId && t.amount > 0
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
  try {
    const stripe = await getServerStripe();
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
      description: `Purchase of ${amount} buzz. Multiplier applied due to membership. A total of ${buzzAmount} buzz was added to your account.`,
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

    await eventEngine.processPurchase({
      userId,
      amount,
    });

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
  try {
    const response = await fetch(`${env.BUZZ_ENDPOINT}`, { signal: AbortSignal.timeout(1000) });
    return response.ok;
  } catch {
    return false;
  }
}

export async function getTransactionByExternalId(externalId: string) {
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
  const claimable = await dbRead.buzzClaim.findUnique({
    where: { key: id },
  });

  const details = {
    title: claimable?.title ?? 'Unknown',
    description: claimable?.description ?? 'Unknown',
    amount: claimable?.amount ?? 0,
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

  const query = claimable.transactionIdQuery.replace('${userId}', userId.toString());
  let transactionId: string | undefined;
  try {
    const transactionIdRows = await dbRead.$queryRawUnsafe<{ transactionId: string }[]>(query);
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

  await createBuzzTransaction({
    amount: claimStatus.details.amount,
    externalTransactionId: claimStatus.claimId,
    fromAccountId: 0,
    toAccountId: userId,
    type: TransactionType.Reward,
    description: `Claimed reward: ${claimStatus.details.title}`,
  });

  return {
    status: 'claimed',
    details: claimStatus.details,
    claimedAt: new Date(),
  } as BuzzClaimResult;
}
