import dayjs from '~/shared/utils/dayjs';
import * as z from 'zod';
import { newOrderConfig } from '~/server/common/constants';
import { NewOrderDamnedReason, NewOrderImageRatingStatus, NsfwLevel } from '~/server/common/enums';
import { infiniteQuerySchema } from '~/server/schema/base.schema';
import { DEFAULT_PAGE_SIZE } from '~/server/utils/pagination-helpers';
import { NewOrderRankType } from '~/shared/utils/prisma/enums';

export type GetImagesQueueSchema = z.input<typeof getImagesQueueSchema>;
export const getImagesQueueSchema = z.object({
  // TODO: add playerId to the schema
  imageCount: z.number().optional().default(20),
  queueType: z.enum({ ...NewOrderRankType, Inquisitor: 'Inquisitor' } as const).optional(),
});

export type GetPlayersInfiniteSchema = z.infer<typeof getPlayersInfiniteSchema>;
export const getPlayersInfiniteSchema = infiniteQuerySchema.extend({
  query: z.string().trim().min(1).optional(),
});

export type SmitePlayerInput = z.infer<typeof smitePlayerSchema>;
export const smitePlayerSchema = z.object({
  playerId: z.number(),
  imageId: z.number().optional(), // needed for optimistic update
  reason: z.string().optional(),
  size: z.number().optional().default(newOrderConfig.smiteSize),
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
  rating: z.enum(NsfwLevel),
  damnedReason: z.enum(NewOrderDamnedReason).optional(),
});

const transformStatus = {
  [NewOrderImageRatingStatus.AcolyteCorrect]: [
    NewOrderImageRatingStatus.AcolyteCorrect,
    NewOrderImageRatingStatus.Correct,
  ],
  [NewOrderImageRatingStatus.AcolyteFailed]: [
    NewOrderImageRatingStatus.AcolyteFailed,
    NewOrderImageRatingStatus.Failed,
  ],
  [NewOrderImageRatingStatus.Correct]: [
    NewOrderImageRatingStatus.Correct,
    NewOrderImageRatingStatus.AcolyteCorrect,
  ],
  [NewOrderImageRatingStatus.Failed]: [
    NewOrderImageRatingStatus.Failed,
    NewOrderImageRatingStatus.AcolyteFailed,
  ],
  [NewOrderImageRatingStatus.Pending]: [NewOrderImageRatingStatus.Pending],
} as const;

export type GetHistoryInput = z.input<typeof getHistorySchema>;
export type GetHistorySchema = z.infer<typeof getHistorySchema>;
export const getHistorySchema = z.object({
  limit: z.number().optional().default(DEFAULT_PAGE_SIZE),
  cursor: z
    .union([z.bigint(), z.number(), z.string(), z.date()])
    .transform((val) =>
      typeof val === 'string' && dayjs(val, 'YYYY-MM-DDTHH:mm:ss.SSS[Z]', true).isValid()
        ? new Date(val)
        : val
    )
    .optional(),
  status: z
    .nativeEnum(NewOrderImageRatingStatus)
    .transform((val) => {
      return transformStatus[val] ?? undefined;
    })
    .optional(),
});

export type ResetPlayerByIdInput = z.infer<typeof resetPlayerByIdSchema>;
export const resetPlayerByIdSchema = z.object({
  playerId: z.number(),
});

export type GetImageRatersInput = z.infer<typeof getImageRatersSchema>;
export const getImageRatersSchema = z.object({
  imageId: z.number(),
});
