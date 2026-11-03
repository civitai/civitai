import * as z from 'zod';
import { stickerPlacementDataSchema } from '~/server/schema/placement.schema';

// Where a hat sticker sits on the image: a regular sticker's geometry, without its comment or
// opacity (a turf sticker's opacity says whether a hat protects the image).
export const turfStickerDataSchema = stickerPlacementDataSchema.pick({
  x: true,
  y: true,
  scale: true,
  rotation: true,
  flip: true,
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

export const turfEventSchema = z.object({ event: eventName });

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

export const removeTurfStickerSchema = z.object({ id: z.coerce.bigint().positive() });

export const turfStickersForImagesSchema = z.object({
  event: eventName,
  imageIds: z.array(z.number().int().positive()).max(100),
  perImage: z.number().int().min(1).max(5).default(5),
});

export const watchTurfImagesSchema = z.object({
  event: eventName,
  imageIds: z.array(z.number().int().positive()).max(50),
});
