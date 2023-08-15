import { TRPCError } from '@trpc/server';
import { env } from '~/env/server.mjs';
import {
  GetUserBuzzAccountResponse,
  GetUserBuzzAccountSchema,
  GetUserBuzzTransactionsSchema,
  GetUserBuzzTransactionsResponse,
  CreateBuzzTransactionInput,
} from '~/server/schema/buzz.schema';
import { throwBadRequestError } from '~/server/utils/errorHandling';
import { QS } from '~/utils/qs';

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
  const queryString = QS.stringify(query);
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

  const data: GetUserBuzzTransactionsResponse = await response.json();
  return data;
}

export async function createBuzzTransaction(
  payload: CreateBuzzTransactionInput & { fromAccountId: number }
) {
  const body = JSON.stringify(payload);
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

  const data: { transactionId: string } = await response.json();
  return data;
}
