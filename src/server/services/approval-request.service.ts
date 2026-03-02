import { Prisma } from '@prisma/client';
import { TRPCError } from '@trpc/server';
import { dbRead, dbWrite } from '~/server/db/client';
import { logToAxiom } from '~/server/logging/client';
import type {
  CreateApprovalRequestInput,
  DecideApprovalRequestInput,
  GetApprovalRequestsInput,
  GetApprovalRequestStatusInput,
} from '~/server/schema/approval-request.schema';
import { getPagination, getPagingData } from '~/server/utils/pagination-helpers';
import { ApprovalRequestStatus } from '~/shared/utils/prisma/enums';

// ============================================================================
// Create Functions
// ============================================================================

/**
 * Create a new approval request from an agent.
 * Returns the created request's id and status.
 */
export async function createApprovalRequest(input: CreateApprovalRequestInput) {
  const {
    action,
    entityType,
    entityId,
    targetUserId,
    summary,
    reasoning,
    evidence,
    safePreviewUrl,
    reviewUrl,
    agentSessionId,
    agentType,
    actionParams,
  } = input;

  const request = await dbWrite.approvalRequest.create({
    data: {
      action,
      entityType,
      entityId,
      targetUserId,
      summary,
      reasoning,
      evidence: evidence ?? Prisma.JsonNull,
      safePreviewUrl,
      reviewUrl,
      agentSessionId,
      agentType,
      actionParams: actionParams ?? Prisma.JsonNull,
      status: ApprovalRequestStatus.Pending,
    },
    select: {
      id: true,
      status: true,
    },
  });

  logToAxiom({
    type: 'info',
    name: 'approval-request-created',
    message: `Approval request created: ${action}`,
    approvalRequestId: request.id,
    action,
    agentType,
    agentSessionId,
    entityType,
    entityId,
    targetUserId,
  });

  return { id: request.id, status: 'Pending' as const };
}

// ============================================================================
// Query Functions
// ============================================================================

/**
 * Get paginated approval requests with optional filters.
 * Used by moderators to view the approval queue.
 */
export async function getApprovalRequests(input: GetApprovalRequestsInput) {
  const { limit, page, status, agentType, action } = input;
  const { take, skip } = getPagination(limit, page);

  const where: Prisma.ApprovalRequestWhereInput = {
    ...(status?.length && { status: { in: status } }),
    ...(agentType && { agentType }),
    ...(action && { action }),
  };

  const [items, count] = await Promise.all([
    dbRead.approvalRequest.findMany({
      where,
      include: {
        decidedByUser: {
          select: { id: true, username: true },
        },
      },
      orderBy: { createdAt: 'desc' },
      take,
      skip,
    }),
    dbRead.approvalRequest.count({ where }),
  ]);

  return getPagingData({ items, count }, take, page);
}

/**
 * Get the status of a single approval request.
 * Used by agents to poll for decision results.
 */
export async function getApprovalRequestStatus(input: GetApprovalRequestStatusInput) {
  const { id } = input;

  const request = await dbRead.approvalRequest.findUnique({
    where: { id },
    select: {
      status: true,
      decidedAt: true,
      rejectionReason: true,
    },
  });

  if (!request) {
    throw new TRPCError({
      code: 'NOT_FOUND',
      message: `Approval request ${id} not found`,
    });
  }

  return request;
}

// ============================================================================
// Decision Functions
// ============================================================================

/**
 * Record a moderator's decision on an approval request.
 * Only allows deciding requests that are currently Pending.
 * Logs the decision to Axiom for audit purposes.
 */
export async function decideApprovalRequest(
  input: DecideApprovalRequestInput & { decidedBy: number }
) {
  const { id, decision, rejectionReason, decidedBy } = input;

  // Atomic update: only decide if currently Pending (prevents race conditions)
  const { count } = await dbWrite.approvalRequest.updateMany({
    where: { id, status: ApprovalRequestStatus.Pending },
    data: {
      status: decision as ApprovalRequestStatus,
      decidedAt: new Date(),
      decidedBy,
      ...(rejectionReason && { rejectionReason }),
    },
  });

  if (count === 0) {
    // Determine why: not found vs wrong status
    const existing = await dbRead.approvalRequest.findUnique({
      where: { id },
      select: { status: true },
    });

    if (!existing) {
      throw new TRPCError({
        code: 'NOT_FOUND',
        message: `Approval request ${id} not found`,
      });
    }

    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: `Cannot decide on a request with status "${existing.status}". Only pending requests can be decided.`,
    });
  }

  // Fetch the updated request for logging details
  const request = await dbRead.approvalRequest.findUniqueOrThrow({
    where: { id },
    select: {
      id: true,
      action: true,
      agentType: true,
      agentSessionId: true,
      entityType: true,
      entityId: true,
      targetUserId: true,
      status: true,
      decidedAt: true,
    },
  });

  logToAxiom({
    type: 'info',
    name: 'approval-request-decided',
    message: `Approval request ${decision.toLowerCase()}: ${request.action}`,
    approvalRequestId: request.id,
    action: request.action,
    decision,
    decidedBy,
    agentType: request.agentType,
    agentSessionId: request.agentSessionId,
    entityType: request.entityType,
    entityId: request.entityId,
    targetUserId: request.targetUserId,
    ...(rejectionReason && { rejectionReason }),
  });

  return request;
}
