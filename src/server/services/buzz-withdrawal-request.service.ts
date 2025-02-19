import { Prisma } from '@prisma/client';
import { v4 as uuid } from 'uuid';
import { BuzzWithdrawalRequestSort, NotificationCategory } from '~/server/common/enums';
import { logToAxiom } from '~/server/logging/client';
import { GetByIdStringInput } from '~/server/schema/base.schema';
import { createNotification } from '~/server/services/notification.service';
import {
  payToStripeConnectAccount,
  payToTipaltiAccount,
  revertStripeConnectTransfer,
} from '~/server/services/user-payment-configuration.service';
import {
  BuzzWithdrawalRequestStatus,
  UserPaymentConfigurationProvider,
} from '~/shared/utils/prisma/enums';
import { getBuzzWithdrawalDetails } from '~/utils/number-helpers';
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
import {
  buzzWithdrawalRequestDetails,
  buzzWithdrawalRequestModerationDetails,
} from '../selectors/buzzWithdrawalRequest.select';
import { throwBadRequestError, throwInsufficientFundsError } from '../utils/errorHandling';
import { DEFAULT_PAGE_SIZE, getPagination, getPagingData } from '../utils/pagination-helpers';
import { createBuzzTransaction, getUserBuzzAccount } from './buzz.service';

export const createBuzzWithdrawalRequest = async ({
  amount,
  userId,
  provider,
}: // Update schema to take target provider if needed.
CreateBuzzWithdrawalRequestSchema & {
  userId: number;
}) => {
  if (provider === UserPaymentConfigurationProvider.Stripe) {
    throw throwBadRequestError('We have disabled Stripe payments for the time being.');
  }

  const userPaymentConfiguration = await dbRead.userPaymentConfiguration.findFirst({
    where: { userId },
  });

  if (!userPaymentConfiguration) {
    throw throwBadRequestError('You must have a connected stripe account to withdraw funds');
  }

  // Update here to support another provider.
  const requirements =
    provider === UserPaymentConfigurationProvider.Tipalti
      ? userPaymentConfiguration.tipaltiPaymentsEnabled && userPaymentConfiguration.tipaltiAccountId
      : userPaymentConfiguration.stripePaymentsEnabled && userPaymentConfiguration.stripeAccountId;
  if (!requirements) {
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
    accountType: 'user',
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
    const providerData: {
      requestedToProvider: UserPaymentConfigurationProvider;
      requestedToId: string;
    } =
      provider === UserPaymentConfigurationProvider.Tipalti
        ? {
            requestedToProvider: UserPaymentConfigurationProvider.Tipalti,
            requestedToId: userPaymentConfiguration.tipaltiAccountId as string,
          }
        : {
            requestedToProvider: UserPaymentConfigurationProvider.Stripe,
            requestedToId: userPaymentConfiguration.stripeAccountId as string,
          };
    // Create the withdrawal request:
    const request = await dbWrite.buzzWithdrawalRequest.create({
      data: {
        userId,
        buzzWithdrawalTransactionId: transaction.transactionId,
        requestedBuzzAmount: amount,
        platformFeeRate: constants.buzz.platformFeeRate,
        ...providerData,
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

export const getPaginatedBuzzWithdrawalRequests = async (
  input: GetPaginatedBuzzWithdrawalRequestSchema
) => {
  const { limit = DEFAULT_PAGE_SIZE, page, username, status, requestId } = input || {};
  const { take, skip } = getPagination(limit, page);
  let userId: number | { in: number[] } | undefined = input.userId;

  if (username && !userId) {
    // The list here is much shorter:
    const userIds = await dbRead.$queryRaw<{ id: number }[]>`
      SELECT DISTINCT (u.id) FROM "BuzzWithdrawalRequest" bwr 
      JOIN "User" u ON bwr."userId" = u.id 
      WHERE u.username ILIKE ${username + '%'}
    `;

    userId = { in: userIds.map((u) => u.id) };
  }

  let orderBy: Prisma.BuzzWithdrawalRequestFindManyArgs['orderBy'] = {};
  if (input.sort) {
    if (input.sort === BuzzWithdrawalRequestSort.Newest) {
      orderBy = { createdAt: 'desc' };
    } else if (input.sort === BuzzWithdrawalRequestSort.Oldest) {
      orderBy = { createdAt: 'asc' };
    } else if (input.sort === BuzzWithdrawalRequestSort.HighestAmount) {
      orderBy = { requestedBuzzAmount: 'desc' };
    } else if (input.sort === BuzzWithdrawalRequestSort.LowestAmount) {
      orderBy = { requestedBuzzAmount: 'asc' };
    }
  }

  const where: Prisma.BuzzWithdrawalRequestFindManyArgs['where'] = {
    status: (status?.length ?? 0) > 0 ? { in: status } : undefined,
    userId,
    id: requestId,
    createdAt:
      input.from || input.to
        ? {
            ...(input.from ? { gte: input.from } : {}),
            ...(input.to ? { lte: input.to } : {}),
          }
        : undefined,
  };

  const items = await dbRead.buzzWithdrawalRequest.findMany({
    where,
    take,
    skip,
    select: buzzWithdrawalRequestModerationDetails,
    orderBy,
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
  requestIds,
  status,
  note,
  userId,
  metadata: updatedMetadata,
  refundFees,
}: UpdateBuzzWithdrawalRequestSchema & {
  userId: number;
}) => {
  // Check if the user has  a pending withdrawal request:
  const requests = await dbRead.buzzWithdrawalRequest.findMany({
    where: {
      id: {
        in: requestIds,
      },
    },
  });

  if (requests.length === 0) {
    throw throwBadRequestError('The request you are trying to update does not exist');
  }

  if (requests.length > 1) {
    const allRequested = requests.every((r) => r.status === BuzzWithdrawalRequestStatus.Requested);
    if (!allRequested) {
      throw throwBadRequestError(
        'You can only update multiple requests at once if they are all in a pending status'
      );
    }
  }

  type BaseRequest = (typeof requests)[number];

  const processRequest = async (request: BaseRequest) => {
    const requestId = request.id;
    const possibleStates = BuzzWithdrawalStatusStateMap[request.status];

    if (!possibleStates.includes(status) && request.status !== status) {
      throw throwBadRequestError(
        `You cannot change the status of a withdrawal request from ${request.status} to ${status}`
      );
    }

    // We'll be deducting funds before the transaction mainly to avoid the tx taking too long. In the case of a tx failure, we'll  refund the user.
    let metadata: BuzzWithdrawalRequestHistoryMetadataSchema = (request.metadata ??
      {}) as BuzzWithdrawalRequestHistoryMetadataSchema;

    metadata = {
      ...metadata,
      ...(updatedMetadata ?? {}),
    };

    if (status === request.status) {
      // Update metadata and move on
      await dbWrite.buzzWithdrawalRequestHistory.create({
        data: {
          updatedById: userId,
          requestId,
          status,
          metadata: metadata as any,
          note,
        },
      });

      await dbWrite.buzzWithdrawalRequest.update({
        where: { id: requestId },
        data: {
          metadata: metadata as any,
        },
      });

      const updatedRequest = await dbWrite.buzzWithdrawalRequest.findUniqueOrThrow({
        where: { id: requestId },
        select: buzzWithdrawalRequestModerationDetails,
      });

      await createNotification({
        userId: request.userId as number,
        type: 'creators-program-withdrawal-updated',
        category: NotificationCategory.System,
        key: `creators-program-withdrawal-updated:${uuid()}`,
        details: {},
      }).catch();

      return updatedRequest;
    }

    if (
      status === BuzzWithdrawalRequestStatus.Rejected ||
      status === BuzzWithdrawalRequestStatus.Canceled
    ) {
      const transaction = await createBuzzTransaction({
        fromAccountId: 0, // bank
        toAccountId: request.userId as number,
        amount: request.requestedBuzzAmount - (refundFees ?? 0),
        type: TransactionType.Refund,
        description: `Refund due to rejection or cancellation of withdrawal request. ${
          refundFees
            ? `A total of ${refundFees} BUZZ has not been refunded due to fees by the Payment provider upon issues with the payment`
            : ''
        }`,
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
      const userPaymentConfiguration = await dbRead.userPaymentConfiguration.findFirst({
        where: { userId: request.userId },
      });

      if (!userPaymentConfiguration) {
        throw throwBadRequestError(
          'We could not find a payment configuration for the provided user'
        );
      }

      if (request.requestedToProvider === UserPaymentConfigurationProvider.Stripe) {
        const transfer = await payToStripeConnectAccount({
          toUserId: request.userId as number, // Ofcs, user should exist for one.
          amount: payoutAmount, // Tipalti doesn't use cents like 99% of other payment processors.
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

      if (
        request.requestedToProvider === UserPaymentConfigurationProvider.Tipalti &&
        userId !== -1
      ) {
        throw throwBadRequestError(
          'Tipalti is not supported for transfers. Approving the request will create a transfer request in the Tipalti dashboard.'
        );
      }
    }

    if (
      status === BuzzWithdrawalRequestStatus.Approved &&
      request.requestedToProvider === UserPaymentConfigurationProvider.Tipalti
    ) {
      if (!request.userId) {
        throw throwBadRequestError(
          'The user you are trying to transfer to has been deleted or a problem caused the withdrawal request to be orphaned.'
        );
      }
      // Transfer the funds to the user's stripe account:
      const userPaymentConfiguration = await dbRead.userPaymentConfiguration.findFirst({
        where: { userId: request.userId },
      });

      if (!userPaymentConfiguration) {
        throw throwBadRequestError('You must have a connected stripe account to withdraw funds');
      }

      const { paymentBatchId, paymentRefCode } = await payToTipaltiAccount({
        requestId,
        toUserId: request.userId as number, // Ofcs, user should exist for one.
        amount: payoutAmount / 100, // Tipalti doesn't use cents like 99% of other payment processors.
        description: `Payment for withdrawal request ${requestId}`,
        byUserId: userId,
      });

      metadata.tipaltiPaymentBatchId = paymentBatchId;
      metadata.tipaltiPaymentRefCode = paymentRefCode;
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

      if (request.requestedToProvider === 'Stripe') {
        const revesal = await revertStripeConnectTransfer({
          transferId: transferRecordMetadata.stripeTransferId as string,
        });

        metadata.stripeReversalId = revesal.id;
      }
    }

    try {
      // Create the withdrawal request:
      await dbWrite.buzzWithdrawalRequestHistory.create({
        data: {
          updatedById: userId,
          requestId,
          status,
          metadata: metadata as any,
          note,
        },
      });

      if (status === BuzzWithdrawalRequestStatus.Transferred) {
        // Ensure we update the main request details:
        await dbWrite.buzzWithdrawalRequest.update({
          where: { id: requestId },
          data: {
            transferId:
              request.requestedToProvider === UserPaymentConfigurationProvider.Tipalti
                ? undefined
                : metadata.stripeTransferId,
            transferredAmount: payoutAmount,
            metadata: metadata as any,
          },
        });
      }

      if (
        status === BuzzWithdrawalRequestStatus.Approved &&
        request.requestedToProvider === UserPaymentConfigurationProvider.Tipalti
      ) {
        // Ensure we update the main request details:
        await dbWrite.buzzWithdrawalRequest.update({
          where: { id: requestId },
          data: {
            transferId: metadata.tipaltiPaymentRefCode,
            transferredAmount: payoutAmount,
            metadata: metadata as any,
          },
        });
      }

      switch (status) {
        case BuzzWithdrawalRequestStatus.Approved:
          await createNotification({
            userId: request.userId as number,
            type: 'creators-program-withdrawal-approved',
            category: NotificationCategory.System,
            key: `creators-program-withdrawal-approved:${uuid()}`,
            details: {},
          }).catch();
          break;
        case BuzzWithdrawalRequestStatus.Rejected:
          await createNotification({
            userId: request.userId as number,
            type: 'creators-program-withdrawal-rejected',
            category: NotificationCategory.System,
            key: `creators-program-withdrawal-rejected:${uuid()}`,
            details: {},
          }).catch();
          break;
        case BuzzWithdrawalRequestStatus.Transferred:
          await createNotification({
            userId: request.userId as number,
            type: 'creators-program-withdrawal-transferred',
            category: NotificationCategory.System,
            key: `creators-program-withdrawal-transferred:${uuid()}`,
            details: {},
          }).catch();
          break;
        case BuzzWithdrawalRequestStatus.Reverted:
          await createNotification({
            userId: request.userId as number,
            type: 'creators-program-withdrawal-reverted',
            category: NotificationCategory.System,
            key: `creators-program-withdrawal-reverted:${uuid()}`,
            details: {},
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

  return await Promise.all(
    requests.map(async (req) => {
      try {
        // Worse case is we'll need to re-process it alone, hence nothing too bad. We'll just return the error.
        return processRequest(req);
      } catch (e) {
        await logToAxiom({
          type: 'update-buzz-withdrawal-request-error',
          message: 'Failed to update withdrawal request',
          data: {
            requestId: req.id,
            error: e,
          },
        });

        return e;
      }
    })
  );
};
