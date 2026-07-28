import * as z from 'zod';

export type GetMinorHashMatchesInput = z.infer<typeof getMinorHashMatchesSchema>;
export const getMinorHashMatchesSchema = z.object({
  page: z.number().min(1).default(1),
  limit: z.number().min(1).max(100).default(25),
});
