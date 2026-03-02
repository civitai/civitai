import * as z from 'zod';
import { paginationSchema } from '~/server/schema/base.schema';
import { ApprovalRequestStatus } from '~/shared/utils/prisma/enums';

// Schema for creating an approval request (called by agents)
export const createApprovalRequestSchema = z.object({
  action: z.string().min(1),
  entityType: z.string().optional(),
  entityId: z.number().optional(),
  targetUserId: z.number().optional(),
  summary: z.string().min(1),
  reasoning: z.string().min(1),
  evidence: z.any().optional(),
  safePreviewUrl: z.string().url().optional(),
  reviewUrl: z.string().url().optional(),
  agentSessionId: z.string().min(1),
  agentType: z.string().min(1),
  actionParams: z.any(),
});
export type CreateApprovalRequestInput = z.infer<typeof createApprovalRequestSchema>;

// Schema for listing approval requests with filters
export const getApprovalRequestsSchema = z.object({
  ...paginationSchema.shape,
  status: z.array(z.enum(ApprovalRequestStatus)).optional(),
  agentType: z.string().optional(),
  action: z.string().optional(),
});
export type GetApprovalRequestsInput = z.infer<typeof getApprovalRequestsSchema>;

// Schema for moderator decision on an approval request
export const decideApprovalRequestSchema = z
  .object({
    id: z.number(),
    decision: z.enum(['Approved', 'Rejected']),
    rejectionReason: z.string().optional(),
  })
  .refine(
    (data) => {
      // If rejected, rejection reason is required
      if (data.decision === 'Rejected') {
        return !!data.rejectionReason && data.rejectionReason.trim().length > 0;
      }
      return true;
    },
    {
      message: 'Rejection reason is required when rejecting a request',
      path: ['rejectionReason'],
    }
  );
export type DecideApprovalRequestInput = z.infer<typeof decideApprovalRequestSchema>;

// Schema for checking status of a single approval request
export const getApprovalRequestStatusSchema = z.object({
  id: z.number(),
});
export type GetApprovalRequestStatusInput = z.infer<typeof getApprovalRequestStatusSchema>;
