import { BuzzWithdrawalRequestStatus, Prisma } from '@prisma/client';
import { constants } from '../common/constants';
import { dbRead, dbWrite } from '../db/client';
import {
  CreateBuzzWithdrawalRequestSchema,
  GetPaginatedBuzzWithdrawalRequestForModerationSchema,
  GetPaginatedBuzzWithdrawalRequestSchema,
} from '../schema/buzz-withdrawal-request.schema';
import { TransactionType } from '../schema/buzz.schema';
import { throwBadRequestError, throwInsufficientFundsError } from '../utils/errorHandling';
import { createBuzzTransaction, getUserBuzzAccount } from './buzz.service';
import { DEFAULT_PAGE_SIZE, getPagination, getPagingData } from '../utils/pagination-helpers';
import {
  buzzWithdrawalRequestDetails,
  buzzWithdrawalRequestModerationDetails,
} from '../selectors/buzzWithdrawalRequest.select';

export const createBuzzWithdrawalRequest = async ({
  amount,
  userId,
}: CreateBuzzWithdrawalRequestSchema & {
  userId: number;
}) => {
  const userStripeConnect = await dbRead.userStripeConnect.findFirst({
    where: { userId },
  });

  if (!userStripeConnect) {
    throw throwBadRequestError('You must have a connected stripe account to withdraw funds');
  }

  if (!userStripeConnect.payoutsEnabled) {
    throw throwBadRequestError('Your account has not been approved yet and cannot withdraw funds');
  }

  // Check if the user has  a pending withdrawal request:
  const pendingRequest = await dbRead.buzzWithdrawalRequest.findFirst({
    where: { userId, status: BuzzWithdrawalRequestStatus.Requested },
  });

  if (pendingRequest) {
    throw throwBadRequestError(
      'You already have a pending withdrawal request. Either cancel it or wait for it to be processed.'
    );
  }

  // Check the user has enough funds:

  const userBuzzAccount = await getUserBuzzAccount({
    accountId: userId,
    accountType: 'User',
  });

  if ((userBuzzAccount?.balance ?? 0) < amount) throw throwInsufficientFundsError();

  // We'll be deducting funds before the transaction mainly to avoid the tx taking too long. In the case of a tx failure, we'll  refund the user.

  const transaction = await createBuzzTransaction({
    fromAccountId: userId,
    toAccountId: 0, // bank
    amount: amount,
    type: TransactionType.Withdrawal,
  });

  try {
    console.log({
      userId,
      connectedAccountId: userStripeConnect.connectedAccountId,
      buzzWithdrawalTransactionId: transaction.transactionId,
      requestedBuzzAmount: amount,
      platformFeeRate: constants.buzz.platformFeeRate,
    });
    // Create the withdrawal request:
    const request = await dbWrite.buzzWithdrawalRequest.create({
      data: {
        userId,
        connectedAccountId: userStripeConnect.connectedAccountId,
        buzzWithdrawalTransactionId: transaction.transactionId,
        requestedBuzzAmount: amount,
        platformFeeRate: constants.buzz.platformFeeRate,
      },
      select: buzzWithdrawalRequestDetails,
    });

    return request;
  } catch (e) {
    // Refund the user:
    await createBuzzTransaction({
      fromAccountId: 0, // bank
      toAccountId: userId,
      amount: amount,
      type: TransactionType.Refund,
      description: 'There was an error while trying to create your withdrawal request.',
      externalTransactionId: transaction.transactionId,
    });

    throw e;
  }
};

export const getPaginatedOwnedBuzzWithdrawalRequests = async (
  input: GetPaginatedBuzzWithdrawalRequestSchema & { userId: number }
) => {
  const { limit = DEFAULT_PAGE_SIZE, page } = input || {};
  const { take, skip } = getPagination(limit, page);
  const where: Prisma.BuzzWithdrawalRequestFindManyArgs['where'] = {
    status: input.status,
    userId: input.userId,
  };
  const items = await dbRead.buzzWithdrawalRequest.findMany({
    where,
    take,
    skip,
    select: buzzWithdrawalRequestDetails,
    orderBy: { createdAt: 'desc' },
  });

  const count = await dbRead.buzzWithdrawalRequest.count({ where });

  return getPagingData({ items, count: (count as number) ?? 0 }, limit, page);
};

export const getPaginatedBuzzWithdrawalRequests = async (
  input: GetPaginatedBuzzWithdrawalRequestForModerationSchema
) => {
  const { limit = DEFAULT_PAGE_SIZE, page, username, status } = input || {};
  const { take, skip } = getPagination(limit, page);
  let userId = input.userId;

  if (username && !userId) {
    const user = await dbRead.user.findUniqueOrThrow({
      where: { username },
    });

    userId = user.id;
  }

  const where: Prisma.BuzzWithdrawalRequestFindManyArgs['where'] = {
    status,
    userId,
  };

  const items = await dbRead.buzzWithdrawalRequest.findMany({
    where,
    take,
    skip,
    select: buzzWithdrawalRequestModerationDetails,
    orderBy: { createdAt: 'desc' },
  });

  const count = await dbRead.buzzWithdrawalRequest.count({ where });

  return getPagingData({ items, count: (count as number) ?? 0 }, limit, page);
};
