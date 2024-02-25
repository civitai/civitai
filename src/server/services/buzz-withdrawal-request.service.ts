import { BuzzWithdrawalRequestStatus, Prisma } from '@prisma/client';
import { constants } from '../common/constants';
import { dbRead, dbWrite } from '../db/client';
import {
  BuzzWithdrawalRequestHistoryMetadataSchema,
  CreateBuzzWithdrawalRequestSchema,
  GetPaginatedBuzzWithdrawalRequestSchema,
  GetPaginatedOwnedBuzzWithdrawalRequestSchema,
  UpdateBuzzWithdrawalRequestSchema,
} from '../schema/buzz-withdrawal-request.schema';
import { TransactionType } from '../schema/buzz.schema';
import { throwBadRequestError, throwInsufficientFundsError } from '../utils/errorHandling';
import { createBuzzTransaction, getUserBuzzAccount } from './buzz.service';
import { DEFAULT_PAGE_SIZE, getPagination, getPagingData } from '../utils/pagination-helpers';
import {
  buzzWithdrawalRequestDetails,
  buzzWithdrawalRequestModerationDetails,
} from '../selectors/buzzWithdrawalRequest.select';
import { GetByIdStringInput } from '~/server/schema/base.schema';
import { getBuzzWithdrawalDetails } from '~/utils/number-helpers';
import {
  payToStripeConnectAccount,
  revertStripeConnectTransfer,
} from '~/server/services/user-stripe-connect.service';
import { createNotification } from '~/server/services/notification.service';

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
  input: GetPaginatedOwnedBuzzWithdrawalRequestSchema & { userId: number }
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

export type BuzzWithdrawalRequestForModerator = AsyncReturnType<
  typeof getPaginatedBuzzWithdrawalRequests
>['items'][number];
export const getPaginatedBuzzWithdrawalRequests = async (
  input: GetPaginatedBuzzWithdrawalRequestSchema
) => {
  const { limit = DEFAULT_PAGE_SIZE, page, username, status, requestId } = input || {};
  const { take, skip } = getPagination(limit, page);
  let userId = input.userId;

  if (username && !userId) {
    const user = await dbRead.user.findUniqueOrThrow({
      where: { username },
    });

    userId = user.id;
  }

  const where: Prisma.BuzzWithdrawalRequestFindManyArgs['where'] = {
    status: (status?.length ?? 0) > 0 ? { in: status } : undefined,
    userId,
    id: requestId,
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

export const cancelBuzzWithdrawalRequest = async ({
  userId,
  id,
}: GetByIdStringInput & {
  userId: number;
}) => {
  // Check if the user has  a pending withdrawal request:
  const request = await dbRead.buzzWithdrawalRequest.findUniqueOrThrow({
    where: { id },
  });

  if (request.status !== BuzzWithdrawalRequestStatus.Requested) {
    throw throwBadRequestError('The request you are trying to cancel is not on a pending status');
  }

  if (userId !== request.userId) {
    throw throwBadRequestError('Only the owner of a withdrawal request can cancel it.');
  }

  // We'll be deducting funds before the transaction mainly to avoid the tx taking too long. In the case of a tx failure, we'll  refund the user.

  const transaction = await createBuzzTransaction({
    fromAccountId: 0, // bank
    toAccountId: userId,
    amount: request.requestedBuzzAmount,
    type: TransactionType.Refund,
    description: 'Refund due to cancellation of withdrawal request',
    externalTransactionId: request.buzzWithdrawalTransactionId,
  });

  try {
    // Create the withdrawal request:
    await dbWrite.buzzWithdrawalRequestHistory.create({
      data: {
        updatedById: userId,
        requestId: id,
        status: BuzzWithdrawalRequestStatus.Canceled,
        metadata: { buzzTransactionId: transaction.transactionId },
      },
    });

    const updatedRequest = await dbWrite.buzzWithdrawalRequest.findUniqueOrThrow({
      where: { id },
      select: buzzWithdrawalRequestDetails,
    });

    return updatedRequest;
  } catch (e) {
    // Refund the bank:
    await createBuzzTransaction({
      fromAccountId: userId, // bank
      toAccountId: 0,
      amount: request.requestedBuzzAmount,
      type: TransactionType.Withdrawal,
      description: 'Unable to cancel request.',
    });

    throw e;
  }
};

const BuzzWithdrawalStatusStateMap: Record<
  BuzzWithdrawalRequestStatus,
  BuzzWithdrawalRequestStatus[]
> = {
  [BuzzWithdrawalRequestStatus.Requested]: [
    BuzzWithdrawalRequestStatus.Approved,
    BuzzWithdrawalRequestStatus.Canceled,
    BuzzWithdrawalRequestStatus.Rejected,
    BuzzWithdrawalRequestStatus.Transferred,
    BuzzWithdrawalRequestStatus.ExternallyResolved,
  ],
  [BuzzWithdrawalRequestStatus.Approved]: [
    BuzzWithdrawalRequestStatus.Rejected,
    BuzzWithdrawalRequestStatus.Transferred,
    BuzzWithdrawalRequestStatus.ExternallyResolved,
  ],
  [BuzzWithdrawalRequestStatus.Transferred]: [BuzzWithdrawalRequestStatus.Reverted],
  [BuzzWithdrawalRequestStatus.Canceled]: [],
  [BuzzWithdrawalRequestStatus.Rejected]: [], //  Because buzz gets refunded, we don't want to allow any other state.
  [BuzzWithdrawalRequestStatus.Reverted]: [], // Because buzz gets refunded, we don't want to allow any other state.
  [BuzzWithdrawalRequestStatus.ExternallyResolved]: [], // Because buzz gets refunded, we don't want to allow any other state.
};

export const updateBuzzWithdrawalRequest = async ({
  requestId,
  status,
  note,
  userId,
}: UpdateBuzzWithdrawalRequestSchema & {
  userId: number;
}) => {
  // Check if the user has  a pending withdrawal request:
  const request = await dbRead.buzzWithdrawalRequest.findUniqueOrThrow({
    where: { id: requestId },
  });

  const possibleStates = BuzzWithdrawalStatusStateMap[request.status];

  if (!possibleStates.includes(status)) {
    throw throwBadRequestError(
      `You cannot change the status of a withdrawal request from ${request.status} to ${status}`
    );
  }

  // We'll be deducting funds before the transaction mainly to avoid the tx taking too long. In the case of a tx failure, we'll  refund the user.
  const metadata: BuzzWithdrawalRequestHistoryMetadataSchema = {};

  if (
    status === BuzzWithdrawalRequestStatus.Rejected ||
    status === BuzzWithdrawalRequestStatus.Canceled
  ) {
    const transaction = await createBuzzTransaction({
      fromAccountId: 0, // bank
      toAccountId: userId,
      amount: request.requestedBuzzAmount,
      type: TransactionType.Refund,
      description: 'Refund due to rejection or cancellation of withdrawal request',
      externalTransactionId: request.buzzWithdrawalTransactionId,
    });

    metadata.buzzTransactionId = transaction.transactionId;
  }

  const { payoutAmount, platformFee } = getBuzzWithdrawalDetails(
    request.requestedBuzzAmount,
    request.platformFeeRate
  );

  if (status === BuzzWithdrawalRequestStatus.ExternallyResolved && !note) {
    throw throwBadRequestError(
      'You must provide a note when resolving a withdrawal request externally'
    );
  }

  if (status === BuzzWithdrawalRequestStatus.Transferred) {
    if (!request.userId) {
      throw throwBadRequestError(
        'The user you are trying to transfer to has been deleted or a problem caused the withdrawal request to be orphaned.'
      );
    }
    // Transfer the funds to the user's stripe account:
    const userStripeConnect = await dbRead.userStripeConnect.findFirst({
      where: { userId: request.userId },
    });

    if (!userStripeConnect) {
      throw throwBadRequestError('You must have a connected stripe account to withdraw funds');
    }

    const transfer = await payToStripeConnectAccount({
      toUserId: request.userId as number, // Ofcs, user should exist for one.
      amount: payoutAmount,
      description: `Payment for withdrawal request ${requestId}`,
      byUserId: userId,
      metadata: {
        requestId,
        platformFee,
        paymentBy: userId,
        platformFeeRate: request.platformFeeRate,
        requestedBuzzAmount: request.requestedBuzzAmount,
        buzzTransactionId: request.buzzWithdrawalTransactionId,
      },
    });

    metadata.stripeTransferId = transfer.id;
  }

  if (status === BuzzWithdrawalRequestStatus.Reverted) {
    const transferRecord = await dbRead.buzzWithdrawalRequestHistory.findFirstOrThrow({
      where: {
        requestId,
        status: BuzzWithdrawalRequestStatus.Transferred,
      },
    });

    const transferRecordMetadata =
      transferRecord.metadata as BuzzWithdrawalRequestHistoryMetadataSchema;

    if (!transferRecordMetadata.stripeTransferId) {
      throw throwBadRequestError(
        'The transfer record does not have a stripe transfer id. A transfer reversal cannot be performed.'
      );
    }

    if (!request.userId) {
      throw throwBadRequestError(
        'The user you are trying to rever a transfer from has been deleted or a problem caused the withdrawal request to be orphaned.'
      );
    }

    // Refund the user:
    const transaction = await createBuzzTransaction({
      fromAccountId: 0, // bank
      toAccountId: request.userId,
      amount: request.requestedBuzzAmount,
      type: TransactionType.Refund,
      description: 'Refund due to reversal of withdrawal request',
    });

    metadata.buzzTransactionId = transaction.transactionId;

    const revesal = await revertStripeConnectTransfer({
      transferId: transferRecordMetadata.stripeTransferId as string,
    });

    metadata.stripeReversalId = revesal.id;
  }

  try {
    // Create the withdrawal request:
    await dbWrite.buzzWithdrawalRequestHistory.create({
      data: {
        updatedById: userId,
        requestId,
        status,
        metadata,
        note,
      },
    });

    if (status === BuzzWithdrawalRequestStatus.Transferred) {
      // Ensure we update the main request details:
      await dbWrite.buzzWithdrawalRequest.update({
        where: { id: requestId },
        data: {
          transferId: metadata.stripeTransferId,
          transferredAmount: payoutAmount,
        },
      });
    }

    switch (status) {
      case BuzzWithdrawalRequestStatus.Approved:
        await createNotification({
          userId: request.userId as number,
          type: 'creators-program-withdrawal-approved',
          category: 'System',
        }).catch();
        break;
      case BuzzWithdrawalRequestStatus.Rejected:
        await createNotification({
          userId: request.userId as number,
          type: 'creators-program-withdrawal-rejected',
          category: 'System',
        }).catch();
        break;
      case BuzzWithdrawalRequestStatus.Transferred:
        await createNotification({
          userId: request.userId as number,
          type: 'creators-program-withdrawal-transferred',
          category: 'System',
        }).catch();
        break;
      case BuzzWithdrawalRequestStatus.Reverted:
        await createNotification({
          userId: request.userId as number,
          type: 'creators-program-withdrawal-reverted',
          category: 'System',
        }).catch();
        break;
    }

    const updatedRequest = await dbWrite.buzzWithdrawalRequest.findUniqueOrThrow({
      where: { id: requestId },
      select: buzzWithdrawalRequestModerationDetails,
    });

    return updatedRequest;
  } catch (e) {
    if (metadata.buzzTransactionId) {
      // Refund the bank
      await createBuzzTransaction({
        fromAccountId: request.userId as number, // bank
        toAccountId: 0,
        amount: request.requestedBuzzAmount,
        type: TransactionType.Withdrawal,
        description: 'Unable to cancel or reject request.',
      });
    }

    throw e;
  }
};
