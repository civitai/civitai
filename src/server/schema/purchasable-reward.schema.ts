import { PurchasableRewardUsage } from '@prisma/client';
import { z } from 'zod';
import { paginationSchema } from '~/server/schema/base.schema';
import { comfylessImageSchema } from '~/server/schema/image.schema';

export type PurchasableRewardUpsert = z.infer<typeof purchasableRewardUpsertSchema>;

export const purchasableRewardUpsertSchema = z.object({
  id: z.number().optional(),
  title: z.string(),
  unitPrice: z.number().min(100),
  about: z.string(),
  redeemDetails: z.string(),
  termsOfUse: z.string(),
  usage: z.nativeEnum(PurchasableRewardUsage),
  codes: z.array(z.string()).optional(),
  archived: z.boolean().optional(),
  availableFrom: z.date().optional(),
  availableTo: z.date().optional(),
  availableCount: z.number().optional(),
  coverImage: comfylessImageSchema.nullish(),
});

export type PurchasableRewardPurchase = z.infer<typeof purchasableRewardPurchaseSchema>;

export const purchasableRewardPurchaseSchema = z.object({
  purchasableRewardId: z.number(),
});

export type GetPaginatedPurchasableRewardsSchema = z.infer<
  typeof getPaginatedPurchasableRewardsSchema
>;
export const getPaginatedPurchasableRewardsSchema = paginationSchema.merge(
  z.object({
    limit: z.coerce.number().min(1).max(200).default(60),
  })
);
