import * as z from 'zod';

export type GetAuctionBySlugInput = z.infer<typeof getAuctionBySlugInput>;
export const getAuctionBySlugInput = z.object({
  slug: z.string(),
  d: z.number().max(0).optional(),
});

export type CreateBidInput = z.infer<typeof createBidInput>;
export const createBidInput = z.object({
  auctionId: z.number().int().min(1),
  entityId: z.number().int().min(1),
  amount: z.number(),
  recurringUntil: z.union([z.date(), z.literal('forever')]).optional(),
});

export type DeleteBidInput = z.infer<typeof deleteBidInput>;
export const deleteBidInput = z.object({
  bidId: z.number().int().min(1),
});

export type TogglePauseRecurringBidInput = z.infer<typeof togglePauseRecurringBidInput>;
export const togglePauseRecurringBidInput = deleteBidInput.extend({});

export type GetAuctionBasesInput = z.infer<typeof getAuctionBasesInput>;
export const getAuctionBasesInput = z.object({
  page: z.number().default(1),
  limit: z.number().default(20),
});

export type UpdateAuctionBaseInput = z.infer<typeof updateAuctionBaseInput>;
export const updateAuctionBaseInput = z.object({
  id: z.number().int().min(1),
  quantity: z.number().int().min(1).optional(),
  minPrice: z.number().int().min(1).optional(),
  active: z.boolean().optional(),
  runForDays: z.number().int().min(1).optional(),
  validForDays: z.number().int().min(1).optional(),
  description: z.string().nullable().optional(),
});
