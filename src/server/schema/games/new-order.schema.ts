import { z } from 'zod';
import { NewOrderDamnedReason, NewOrderImageRatingStatus, NsfwLevel } from '~/server/common/enums';
import { infiniteQuerySchema } from '~/server/schema/base.schema';

export type GetImageQueueSchema = z.infer<typeof getImageQueueSchema>;
export const getImageQueueSchema = infiniteQuerySchema.extend({
  // TODO: add playerId to the schema
  imageCount: z.number().optional().default(20),
});

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
  rating: z.nativeEnum(NsfwLevel),
  damnedReason: z.nativeEnum(NewOrderDamnedReason).optional(),
});

export type GetHistorySchema = z.infer<typeof getHistorySchema>;
export const getHistorySchema = infiniteQuerySchema.extend({
  status: z.nativeEnum(NewOrderImageRatingStatus).optional(),
});
