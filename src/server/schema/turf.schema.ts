import * as z from 'zod';
import { stickerPlacementDataSchema } from '~/server/schema/placement.schema';
import {
  STICKER_PLACEMENT_DEFAULT_MAX_SCALE,
  STICKER_PLACEMENT_MIN_SCALE,
} from '~/shared/utils/sticker-placement';

/** A hat is free and can go on anyone's picture, so it gets the size a sticker gets by default. */
export const HAT_MAX_SCALE = STICKER_PLACEMENT_DEFAULT_MAX_SCALE;

// Where a hat sticker sits on the image: a regular sticker's pose, without its comment.
// Hats are always opaque (a product decision), so only full opacity is accepted.
export const turfStickerDataSchema = stickerPlacementDataSchema
  .pick({ x: true, y: true, rotation: true, flip: true })
  .extend({
    scale: z.number().finite().min(STICKER_PLACEMENT_MIN_SCALE).max(HAT_MAX_SCALE),
    opacity: z.literal(1).optional(),
  });
export type TurfStickerData = z.infer<typeof turfStickerDataSchema>;

const eventName = z.string().min(1).max(64);

export const placeTurfStickerSchema = z.object({
  event: eventName,
  imageId: z.number().int().positive(),
  // Which of the player's event hats the sticker shows.
  cosmeticId: z.number().int().positive(),
  data: turfStickerDataSchema,
  // Where the placement started, for the UI experiment readout. Absent from older clients.
  source: z.enum(['feed', 'image-detail']).optional(),
});

/** The most hats one add puts on a flag. The picker offers 1, 5 and this, each capped at what the player has. */
export const FLAG_HAT_MAX = 10;

export const placeFlagHatsSchema = z.object({
  event: eventName,
  imageId: z.number().int().positive(),
  cosmeticId: z.number().int().positive(),
  count: z.number().int().min(1).max(FLAG_HAT_MAX),
});

export const turfEventSchema = z.object({ event: eventName });

export const turfReactionEarnsSchema = z.object({
  event: eventName,
  imageId: z.number().int().positive(),
});

export const turfSummariesSchema = z.object({
  event: eventName,
  imageIds: z.array(z.number().int().positive()).max(100),
});

export const turfImageSchema = z.object({
  event: eventName,
  imageId: z.number().int().positive(),
  // The last sticker of the previous page: return only stickers older than it.
  before: z
    .object({
      createdAt: z.iso.datetime(),
      id: z.coerce.bigint().positive().max(BigInt('9223372036854775807')),
    })
    .optional(),
});
export type TurfStickersCursor = { createdAt: string; id: string };

export const setTurfOptInSchema = z.object({ event: eventName, optedIn: z.boolean() });
export const setTurfOwnerOffSchema = z.object({ event: eventName, off: z.boolean() });

export const removeTurfStickerSchema = z.object({ id: z.coerce.bigint().positive() });

/** Hats a feed card draws per image: what the feed reads, and what a turf push carries. */
export const TURF_FEED_STICKERS = 10;

export const turfStickersForImagesSchema = z.object({
  event: eventName,
  imageIds: z.array(z.number().int().positive()).max(100),
  perImage: z.number().int().min(1).max(TURF_FEED_STICKERS).default(TURF_FEED_STICKERS),
});

export const watchTurfImagesSchema = z.object({
  event: eventName,
  imageIds: z.array(z.number().int().positive()).max(50),
});

/** A sticker's hat art: the cosmetic's image, and where its visible pixels sit (fit canvas, bounds). */
export type TurfHatArt = {
  url: string;
  canvas?: [number, number] | null;
  bounds?: [number, number, number, number] | null;
};
