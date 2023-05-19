import { z } from 'zod';

export type GetLeaderboardPositionsInput = z.infer<typeof getLeaderboardPositionsSchema>;
export const getLeaderboardPositionsSchema = z.object({
  userId: z.number().optional(),
  date: z.date().optional(),
});

export type GetLeaderboardInput = z.infer<typeof getLeaderboardSchema>;
export const getLeaderboardSchema = z.object({
  id: z.string(),
  date: z.date().optional(),
});
