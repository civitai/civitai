import { CosmeticType, CosmeticEntity } from '~/shared/utils/prisma/enums';
import * as z from 'zod';
import { paginationSchema } from '~/server/schema/base.schema';
import { STICKER_TOPUP_MAX_QUANTITY } from '~/shared/utils/sticker-token';
import { stickerPlacementRatings } from '~/shared/constants/cosmetic-flags.constants';
import { HAT_FIT_LIMITS } from '~/shared/constants/event-decoration.constants';

export type SetStickerPlacementRatingInput = z.infer<typeof setStickerPlacementRatingSchema>;
export const setStickerPlacementRatingSchema = z.object({
  id: z.number().int().positive(),
  rating: z.enum(stickerPlacementRatings),
});

export type GetPaginatedCosmeticsInput = z.infer<typeof getPaginatedCosmeticsSchema>;
export const getPaginatedCosmeticsSchema = paginationSchema.merge(
  z.object({
    limit: z.coerce.number().min(1).max(200).default(60),
    name: z.string().optional(),
    types: z.array(z.enum(CosmeticType)).optional(),
  })
);

/**
 * The cap on one sticker lookup. Exported so a caller can slice to it rather
 * than discover it as a zod failure — which is silent on a query, and takes the
 * whole answer with it.
 */
export const STICKER_OFFER_LIMIT = 100;

export type GetStickerCosmeticsInput = z.infer<typeof getStickerCosmeticsSchema>;
export const getStickerCosmeticsSchema = z.object({
  ids: z.array(z.number().int().positive()).min(1).max(STICKER_OFFER_LIMIT),
});

// Buying more uses of a sticker already owned. Keyed on the cosmetic rather than
// a shop item: the per-use price belongs to the sticker, not to any one offer.
export type PurchaseStickerUsesInput = z.infer<typeof purchaseStickerUsesSchema>;
export const purchaseStickerUsesSchema = z.object({
  cosmeticId: z.number().int().positive(),
  quantity: z.number().int().positive().max(STICKER_TOPUP_MAX_QUANTITY),
  // The per-use price the buyer was shown. The server refuses if it has since
  // changed rather than charging a number they never agreed to.
  expectedPricePerUse: z.number().int().positive().optional(),
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

const within = ([lo, hi]: readonly [number, number]) => z.number().min(lo).max(hi);

/**
 * A moderator's change to one event hat's placement. Only these fields can be set, so the art's
 * measured shape (canvas, bounds, brim, outline) is never touched; `null` puts a field back to the
 * default look.
 */
export type UpdateEventHatFitInput = z.infer<typeof updateEventHatFitSchema>;
export const updateEventHatFitSchema = z.object({
  id: z.number().int().positive(),
  fit: z
    .object({
      size: within(HAT_FIT_LIMITS.size).nullable(),
      tilt: within(HAT_FIT_LIMITS.tilt).nullable(),
      depth: within(HAT_FIT_LIMITS.depth).nullable(),
      grow: within(HAT_FIT_LIMITS.grow).nullable(),
      offset: z.tuple([within(HAT_FIT_LIMITS.offset), within(HAT_FIT_LIMITS.offset)]).nullable(),
    })
    .partial()
    .strict(),
});
