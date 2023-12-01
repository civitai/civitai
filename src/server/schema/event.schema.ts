import { z } from 'zod';

export const eventSchema = z.object({
  event: z.string(),
});
export type EventInput = z.infer<typeof eventSchema>;

export type TeamScoreHistoryInput = z.infer<typeof teamScoreHistorySchema>;
export const teamScoreHistorySchema = eventSchema.extend({
  window: z.enum(['hour', 'day', 'week', 'month', 'year']).optional(),
  start: z.date().optional(),
});
