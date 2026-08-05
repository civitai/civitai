import { z } from 'zod';
import { placementSurfaces } from '~/shared/utils/placement';
import {
  STICKER_PLACEMENT_MAX_ROTATION,
  STICKER_PLACEMENT_MAX_SCALE,
  STICKER_PLACEMENT_MIN_SCALE,
} from '~/shared/utils/sticker-placement';

export const placementSurfaceSchema = z.enum(
  placementSurfaces as [string, ...string[]]
) as z.ZodType<(typeof placementSurfaces)[number]>;

const finite = z.number().finite();

/**
 * Bounds, not clamps. The service clamps a drag that ran a pixel past the edge;
 * the schema still refuses a non-finite value, which would render nowhere and be
 * indistinguishable from the sticker not existing.
 */
export const stickerPlacementDataSchema = z.object({
  cosmeticId: z.number().int().positive(),
  x: finite.min(0).max(1),
  y: finite.min(0).max(1),
  scale: finite.min(STICKER_PLACEMENT_MIN_SCALE).max(STICKER_PLACEMENT_MAX_SCALE),
  rotation: finite.min(-STICKER_PLACEMENT_MAX_ROTATION).max(STICKER_PLACEMENT_MAX_ROTATION),
});

export const createStickerPlacementSchema = z.object({
  imageId: z.number().int().positive(),
  data: stickerPlacementDataSchema,
});
export type CreateStickerPlacementInput = z.infer<typeof createStickerPlacementSchema>;

export const getStickerPlacementsSchema = z.object({
  imageIds: z.array(z.number().int().positive()).min(1).max(100),
});

export const actOnStickerPlacementSchema = z.object({
  placementId: z.number().int().positive(),
  action: z.enum(['approve', 'decline', 'remove']),
});

export const placementSpaceSchema = z.object({
  surface: placementSurfaceSchema,
  entityType: z.enum(['image', 'post', 'user']),
  entityId: z.number().int().positive(),
  mode: z.enum(['off', 'review', 'auto']),
  // Distinguishes "leave whatever is set" from "clear it and inherit", which a
  // single optional number cannot: `undefined` keeps, `null` clears.
  price: z.number().int().min(0).nullable().optional(),
});

export const getPlacementSpaceSchema = z.object({
  surface: placementSurfaceSchema,
  targetType: z.enum(['image']),
  targetId: z.number().int().positive(),
});

export const placementPriceRangeSchema = z.object({ surface: placementSurfaceSchema });

export const getPlacementSettlementStatesSchema = z.object({
  placementIds: z.array(z.number().int().positive()).min(1).max(100),
});

export const countPendingPlacementsFromSchema = z.object({
  userId: z.number().int().positive(),
});
