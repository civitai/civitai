import { getTRPCErrorFromUnknown } from '@trpc/server';
import {
  CreateBuzzWithdrawalRequestSchema,
  GetPaginatedBuzzWithdrawalRequestSchema,
  GetPaginatedOwnedBuzzWithdrawalRequestSchema,
  UpdateBuzzWithdrawalRequestSchema,
} from '../schema/buzz-withdrawal-request.schema';
import { Context } from '../createContext';
import {
  cancelBuzzWithdrawalRequest,
  createBuzzWithdrawalRequest,
  getPaginatedBuzzWithdrawalRequests,
  getPaginatedOwnedBuzzWithdrawalRequests,
  updateBuzzWithdrawalRequest,
} from '../services/buzz-withdrawal-request.service';
import { throwAuthorizationError, throwDbError } from '../utils/errorHandling';
import { GetByIdInput, GetByIdStringInput } from '~/server/schema/base.schema';
import { BuzzWithdrawalRequestStatus } from '@prisma/client';
import { hasFeature } from '~/server/services/feature-flags.service';

export function createBuzzWithdrawalRequestHandler({
  input,
  ctx,
}: {
  input: CreateBuzzWithdrawalRequestSchema;
  ctx: DeepNonNullable<Context>;
}) {
  try {
    return createBuzzWithdrawalRequest({ userId: ctx.user.id, ...input });
  } catch (error) {
    throw getTRPCErrorFromUnknown(error);
  }
}

export const getPaginatedOwnedBuzzWithdrawalRequestsHandler = async ({
  input,
  ctx,
}: {
  input: GetPaginatedOwnedBuzzWithdrawalRequestSchema;
  ctx: DeepNonNullable<Context>;
}) => {
  const { user } = ctx;
  try {
    return getPaginatedOwnedBuzzWithdrawalRequests({ ...input, userId: user.id });
  } catch (error) {
    throw throwDbError(error);
  }
};

export const getPaginatedBuzzWithdrawalRequestsHandler = async ({
  input,
  ctx,
}: {
  input: GetPaginatedBuzzWithdrawalRequestSchema;
  ctx: DeepNonNullable<Context>;
}) => {
  try {
    return getPaginatedBuzzWithdrawalRequests({ ...input });
  } catch (error) {
    throw throwDbError(error);
  }
};

export function cancelBuzzWithdrawalRequestHandler({
  input,
  ctx,
}: {
  input: GetByIdStringInput;
  ctx: DeepNonNullable<Context>;
}) {
  try {
    return cancelBuzzWithdrawalRequest({ userId: ctx.user.id, ...input });
  } catch (error) {
    throw getTRPCErrorFromUnknown(error);
  }
}

export function updateBuzzWithdrawalRequestHandler({
  input,
  ctx,
}: {
  input: UpdateBuzzWithdrawalRequestSchema;
  ctx: DeepNonNullable<Context>;
}) {
  try {
    if (
      [BuzzWithdrawalRequestStatus.Reverted, BuzzWithdrawalRequestStatus.Transferred].some(
        (s) => s === input.status
      ) &&
      !hasFeature('buzzWithdrawalTransfer', ctx.user)
    ) {
      // Ensure this user has permission to do this:
      throw throwAuthorizationError('You do not have permission to perform this action');
    }

    return updateBuzzWithdrawalRequest({ userId: ctx.user.id, ...input });
  } catch (error) {
    throw getTRPCErrorFromUnknown(error);
  }
}
