import { z } from 'zod';

const dealId = z.object({ id: z.number().int().positive() });
const text = (max: number) => z.string().trim().min(1).max(max);

export const requestServiceDealSchema = z.object({
  offeringId: z.number().int().positive(),
  /** The terms the buyer was shown; a request on any other terms is refused. */
  expectedPrice: z.number().int().positive(),
  expectedRevisionsIncluded: z.number().int().min(0),
  expectedDeliveryDays: z.number().int().positive(),
  requestText: text(5000),
});

export const getServiceDealSchema = dealId;

export const listMyServiceDealsSchema = z.object({
  role: z.enum(['buyer', 'seller']),
  status: z.enum(['open', 'closed']).optional(),
  cursor: z.number().int().positive().optional(),
  limit: z.number().int().min(1).max(50).default(20),
});

export const serviceDealActionSchema = dealId;
export const declineServiceDealSchema = dealId.extend({ reason: text(1000).optional() });
export const requestServiceDealRevisionSchema = dealId.extend({ comment: text(2000) });
export const requestServiceDealCancellationSchema = dealId.extend({ reason: text(1000) });
export const respondServiceDealCancellationSchema = dealId.extend({
  agree: z.boolean(),
  comment: text(1000).optional(),
});
export const openServiceDealDisputeSchema = dealId.extend({ reason: text(2000) });

const dealFileDealId = z.object({ dealId: z.number().int().positive() });
export const requestServiceDealUploadSchema = dealFileDealId.extend({
  kind: z.enum(['Preview', 'Final']),
  fileName: z.string().trim().min(1).max(255),
  mimeType: z.string().trim().min(1).max(100),
  size: z.number().int().positive(),
});
export const serviceDealFilesSchema = dealFileDealId;
export const serviceDealFileActionSchema = z.object({ fileId: z.number().int().positive() });
