import * as z from 'zod';

export type GetProductsWithBadgesInput = z.infer<typeof getProductsWithBadgesInput>;
export const getProductsWithBadgesInput = z.object({
  name: z.string().optional(),
  provider: z.string().optional(),
});

export type GetBadgeHistoryInput = z.infer<typeof getBadgeHistoryInput>;
export const getBadgeHistoryInput = z.object({
  productId: z.string(),
});

export type UpsertProductBadgeInput = z.infer<typeof upsertProductBadgeInput>;
export const upsertProductBadgeInput = z.object({
  id: z.number().optional(),
  name: z.string().min(1),
  badgeUrl: z.string().min(1),
  animated: z.boolean().default(false),
  productIds: z.array(z.string()).min(1),
  availableStart: z.date(),
  availableEnd: z.date(),
});
