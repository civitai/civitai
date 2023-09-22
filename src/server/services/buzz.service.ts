import { TRPCError } from '@trpc/server';
import { env } from '~/env/server.mjs';
import {
  GetUserBuzzAccountResponse,
  GetUserBuzzAccountSchema,
  GetUserBuzzTransactionsSchema,
  GetUserBuzzTransactionsResponse,
  CreateBuzzTransactionInput,
  getUserBuzzTransactionsResponse,
} from '~/server/schema/buzz.schema';
import { throwBadRequestError } from '~/server/utils/errorHandling';
import { QS } from '~/utils/qs';
import { getUsers } from './user.service';
import { dbRead, dbWrite } from '~/server/db/client';
import { Prisma } from '@prisma/client';

export async function getUserBuzzAccount({ accountId }: GetUserBuzzAccountSchema) {
  const response = await fetch(`${env.BUZZ_ENDPOINT}/account/${accountId}`);
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
}

export async function getUserBuzzTransactions({
  accountId,
  ...query
}: GetUserBuzzTransactionsSchema & { accountId: number }) {
  const queryString = QS.stringify({
    ...query,
    start: query.start?.toISOString(),
    end: query.end?.toISOString(),
    cursor: query.cursor?.toISOString(),
    descending: true,
  });

  const response = await fetch(
    `${env.BUZZ_ENDPOINT}/account/${accountId}/transactions?${queryString}`
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
  const toUserIds = new Set(transactions.map((t) => t.toAccountId));
  const fromUserIds = new Set(transactions.map((t) => t.fromAccountId));
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
  ...payload
}: CreateBuzzTransactionInput & { fromAccountId: number }) {
  if (entityType && entityId && !toAccountId) {
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

  if (!toAccountId) {
    throw throwBadRequestError('No target account provided');
  }

  if (toAccountId === payload.fromAccountId) {
    throw throwBadRequestError('You cannot send buzz to the same account');
  }

  const body = JSON.stringify({
    ...payload,
    toAccountId,
  });

  const response = await fetch(`${env.BUZZ_ENDPOINT}/transaction`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
  });

  if (!response.ok) {
    const cause: { reason: string } = JSON.parse(await response.text());

    switch (response.status) {
      case 400:
        throw throwBadRequestError(cause.reason, cause);
      default:
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'An unexpected error ocurred, please try again later',
          cause,
        });
    }
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
          amount: existingRecord.amount + payload.amount,
        },
      });
    } else {
      await dbWrite.buzzTip.create({
        data: {
          amount: payload.amount,
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
  transactions: (CreateBuzzTransactionInput & { fromAccountId: number })[]
) {
  const body = JSON.stringify(transactions);
  const response = await fetch(`${env.BUZZ_ENDPOINT}/transactions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
  });
  if (!response.ok) {
    const cause: { reason: string } = JSON.parse(await response.text());

    switch (response.status) {
      case 400:
        throw throwBadRequestError(cause.reason, cause);
      default:
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'An unexpected error ocurred, please try again later',
          cause,
        });
    }
  }

  const data: { transactions: { transactionId: string }[] } = await response.json();
  return data;
}
