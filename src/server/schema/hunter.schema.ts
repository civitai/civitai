import { z } from 'zod';

export const hunterUpsertSchema = z.object({
  id: z.number().optional(),
  name: z.string(),
});
export type BountyUpsertSchema = z.infer<typeof hunterUpsertSchema>;
