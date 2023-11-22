import { z } from 'zod';

export const eventSchema = z.object({
  event: z.string(),
});
export type EventInput = z.infer<typeof eventSchema>;
