import { z } from 'zod';

export type GetLeaderboardPositionsInput = z.infer<typeof getLeaderboardPositionsSchema>;
export const getLeaderboardPositionsSchema = z.object({
  userId: z.number().optional(), // This is ok, it's used for caching purposes
  date: z.date().optional(),
  top: z.number().optional(),
  isModerator: z.boolean().optional().default(false),
});

export type GetLeaderboardInput = z.infer<typeof getLeaderboardSchema>;
export const getLeaderboardSchema = z.object({
  id: z.string(),
  date: z.date().optional(),
  isModerator: z.boolean().optional().default(false),
  maxPosition: z.number().optional().default(1000),
});

export type GetLeaderboardsInput = z.infer<typeof getLeaderboardsSchema>;
export const getLeaderboardsSchema = z.object({
  ids: z.array(z.string()).optional(),
  isModerator: z.boolean().optional().default(false),
});
export type GetLeaderboardsWithResultsInput = z.infer<typeof getLeaderboardsWithResultsSchema>;

export const getLeaderboardsWithResultsSchema = z.object({
  ids: z.array(z.string()),
  date: z.date().optional(),
  isModerator: z.boolean().optional().default(false),
});
