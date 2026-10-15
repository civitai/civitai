import { z } from 'zod';

const dealId = z.object({ id: z.number().int().positive() });
const text = (max: number) => z.string().trim().min(1).max(max);

export const requestServiceDealSchema = z.object({
  offeringId: z.number().int().positive(),
  /** The price the buyer was shown; a request at any other price is refused. */
  expectedPrice: z.number().int().positive(),
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
