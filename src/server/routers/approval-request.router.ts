import {
  createApprovalRequestHandler,
  decideApprovalRequestHandler,
  getApprovalRequestsHandler,
  getApprovalRequestStatusHandler,
} from '~/server/controllers/approval-request.controller';
import {
  createApprovalRequestSchema,
  decideApprovalRequestSchema,
  getApprovalRequestsSchema,
  getApprovalRequestStatusSchema,
} from '~/server/schema/approval-request.schema';
import { isFlagProtected, moderatorProcedure, router } from '~/server/trpc';

export const approvalRequestRouter = router({
  // Create endpoint - called by agents (using mod service account)
  create: moderatorProcedure
    .input(createApprovalRequestSchema)
    .mutation(createApprovalRequestHandler),

  // Get all endpoint - for moderator queue view
  getAll: moderatorProcedure
    .input(getApprovalRequestsSchema)
    .use(isFlagProtected('moderationAgents'))
    .query(getApprovalRequestsHandler),

  // Decide endpoint - for moderator approval/rejection
  decide: moderatorProcedure
    .input(decideApprovalRequestSchema)
    .use(isFlagProtected('moderationAgents'))
    .mutation(decideApprovalRequestHandler),

  // Get status endpoint - for agents to poll decision results
  getStatus: moderatorProcedure
    .input(getApprovalRequestStatusSchema)
    .query(getApprovalRequestStatusHandler),
});
