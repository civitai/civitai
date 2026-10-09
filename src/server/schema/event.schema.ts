import * as z from 'zod';
import { CosmeticEntity } from '~/shared/utils/prisma/enums';

export const eventSchema = z.object({
  event: z.string(),
});
export type EventInput = z.infer<typeof eventSchema>;

export type TeamScoreHistoryInput = z.infer<typeof teamScoreHistorySchema>;
export const teamScoreHistorySchema = eventSchema.extend({
  window: z.enum(['hour', 'day', 'week', 'month', 'year']).optional(),
  start: z.date().optional(),
});

export type EventCosmeticScoresInput = z.infer<typeof eventCosmeticScoresSchema>;
export const eventCosmeticScoresSchema = eventSchema.extend({
  cosmetics: z
    .array(
      z.object({
        userId: z.number().int().positive(),
        cosmeticId: z.number().int().positive(),
        claimKey: z.string().min(1).max(100),
      })
    )
    .max(100),
});

export type WornEventHatInput = z.infer<typeof wornEventHatSchema>;
export const wornEventHatSchema = eventSchema.extend({
  entityType: z.enum(CosmeticEntity),
  entityId: z.number().int().positive(),
});
