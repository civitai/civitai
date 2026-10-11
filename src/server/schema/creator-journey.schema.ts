import * as z from 'zod';
import { parseMilestoneShareToken } from '~/shared/constants/creator-journey.constants';

export type LegendStatusInput = z.infer<typeof legendStatusSchema>;
export const legendStatusSchema = z.object({ userId: z.number().int().positive() });

export type ProfileAchievementsInput = z.infer<typeof profileAchievementsSchema>;
export const profileAchievementsSchema = z.object({ userId: z.number().int().positive() });

export type MilestoneShareInput = z.infer<typeof milestoneShareSchema>;
export const milestoneShareSchema = z.object({
  userId: z.number().int().positive(),
  /** A tier slug or an achievement key, as a share link names it. */
  milestone: z.string().refine((value) => parseMilestoneShareToken(value) !== null),
});

export type FirstPublishCardInput = z.infer<typeof firstPublishCardSchema>;
export const firstPublishCardSchema = z.object({
  entityType: z.enum(['model', 'article']),
  id: z.number().int().positive(),
});
