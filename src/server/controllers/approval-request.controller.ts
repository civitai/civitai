import { TRPCError } from '@trpc/server';
import type { Context } from '~/server/createContext';
import type {
  CreateApprovalRequestInput,
  DecideApprovalRequestInput,
  GetApprovalRequestsInput,
  GetApprovalRequestStatusInput,
} from '~/server/schema/approval-request.schema';
import {
  createApprovalRequest,
  decideApprovalRequest,
  getApprovalRequests,
  getApprovalRequestStatus,
} from '~/server/services/approval-request.service';
import { throwDbError } from '~/server/utils/errorHandling';

/**
 * Handler for creating a new approval request.
 * Called by agents submitting requests for moderator review.
 */
export const createApprovalRequestHandler = async ({
  input,
}: {
  input: CreateApprovalRequestInput;
  ctx: DeepNonNullable<Context>;
}) => {
  try {
    return await createApprovalRequest(input);
  } catch (error) {
    if (error instanceof TRPCError) throw error;
    throw throwDbError(error);
  }
};

/**
 * Handler for getting paginated approval requests.
 * Used by moderators to view the approval queue.
 */
export const getApprovalRequestsHandler = async ({
  input,
}: {
  input: GetApprovalRequestsInput;
}) => {
  try {
    return await getApprovalRequests(input);
  } catch (error) {
    if (error instanceof TRPCError) throw error;
    throw throwDbError(error);
  }
};

/**
 * Handler for recording a moderator's decision on an approval request.
 * Logs the decision to Axiom for audit purposes.
 */
export const decideApprovalRequestHandler = async ({
  input,
  ctx,
}: {
  input: DecideApprovalRequestInput;
  ctx: DeepNonNullable<Context>;
}) => {
  try {
    return await decideApprovalRequest({
      ...input,
      decidedBy: ctx.user.id,
    });
  } catch (error) {
    if (error instanceof TRPCError) throw error;
    throw throwDbError(error);
  }
};

/**
 * Handler for getting the status of a single approval request.
 * Used by agents to poll for decision results.
 */
export const getApprovalRequestStatusHandler = async ({
  input,
}: {
  input: GetApprovalRequestStatusInput;
}) => {
  try {
    return await getApprovalRequestStatus(input);
  } catch (error) {
    if (error instanceof TRPCError) throw error;
    throw throwDbError(error);
  }
};
