import { z } from 'zod';

export type GetAuctionBySlugInput = z.infer<typeof getAuctionBySlugInput>;
export const getAuctionBySlugInput = z.object({
  slug: z.string(),
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
