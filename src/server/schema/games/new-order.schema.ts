import { z } from 'zod';
import { NewOrderDamnedReason, NewOrderImageRating } from '~/server/common/enums';

export type SmitePlayerInput = z.infer<typeof smitePlayerSchema>;
export const smitePlayerSchema = z.object({
  playerId: z.number(),
  reason: z.string(),
  size: z.number(),
});

export type CleanseSmiteInput = z.infer<typeof cleanseSmiteSchema>;
export const cleanseSmiteSchema = z.object({
  id: z.number(),
  cleansedReason: z.string(),
  playerId: z.number(),
});

export type AddImageRatingInput = z.infer<typeof addImageRatingSchema>;
export const addImageRatingSchema = z.object({
  imageId: z.number(),
  playerId: z.number(),
  rating: z.nativeEnum(NewOrderImageRating),
  damnedReason: z.nativeEnum(NewOrderDamnedReason).optional(),
});
