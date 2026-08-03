import { CosmeticType, CosmeticEntity } from '~/shared/utils/prisma/enums';
import * as z from 'zod';
import { paginationSchema } from '~/server/schema/base.schema';
import { STICKER_TOPUP_MAX_QUANTITY } from '~/shared/utils/sticker-token';

export type GetPaginatedCosmeticsInput = z.infer<typeof getPaginatedCosmeticsSchema>;
export const getPaginatedCosmeticsSchema = paginationSchema.merge(
  z.object({
    limit: z.coerce.number().min(1).max(200).default(60),
    name: z.string().optional(),
    types: z.array(z.enum(CosmeticType)).optional(),
  })
);

export type GrantCosmeticsToUsersInput = z.infer<typeof grantCosmeticsToUsersSchema>;
export const grantCosmeticsToUsersSchema = z.object({
  cosmeticIds: z.array(z.number()).min(1).max(100),
  userIds: z.array(z.number()).min(1).max(100),
});

export type GetStickerCosmeticsInput = z.infer<typeof getStickerCosmeticsSchema>;
export const getStickerCosmeticsSchema = z.object({
  ids: z.array(z.number().int().positive()).min(1).max(100),
});

// Buying more uses of a sticker already owned. Keyed on the cosmetic rather than
// a shop item: the per-use price belongs to the sticker, not to any one offer.
export type PurchaseStickerUsesInput = z.infer<typeof purchaseStickerUsesSchema>;
export const purchaseStickerUsesSchema = z.object({
  cosmeticId: z.number().int().positive(),
  quantity: z.number().int().positive().max(STICKER_TOPUP_MAX_QUANTITY),
  // Same option the shop purchase takes; rejected server-side when the listing
  // doesn't accept Blue Buzz.
  payWith: z.enum(['default', 'blue-first']).optional(),
});

export type EquipCosmeticInput = z.infer<typeof equipCosmeticSchema>;
export const equipCosmeticSchema = z.object({
  cosmeticId: z.number(),
  equippedToId: z.number(),
  claimKey: z.string().min(1),
  equippedToType: z.enum(CosmeticEntity),
});

export type CosmeticInputSchema = z.infer<typeof cosmeticInputSchema>;
export const cosmeticInputSchema = z.object({
  id: z.number(),
  claimKey: z.string(),
  // data: z.object({}).passthrough().nullable(),
});
