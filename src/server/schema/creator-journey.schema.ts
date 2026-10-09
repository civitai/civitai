import * as z from 'zod';
import type { ScoreTierSlug } from '~/shared/constants/creator-journey.constants';
import { SCORE_TIERS } from '~/shared/constants/creator-journey.constants';

export type LegendStatusInput = z.infer<typeof legendStatusSchema>;
export const legendStatusSchema = z.object({ userId: z.number().int().positive() });

export type ProfileAchievementsInput = z.infer<typeof profileAchievementsSchema>;
export const profileAchievementsSchema = z.object({ userId: z.number().int().positive() });

export type MilestoneShareInput = z.infer<typeof milestoneShareSchema>;
export const milestoneShareSchema = z.object({
  userId: z.number().int().positive(),
  slug: z.enum(SCORE_TIERS.map((tier) => tier.slug) as [ScoreTierSlug, ...ScoreTierSlug[]]),
});

export type FirstPublishCardInput = z.infer<typeof firstPublishCardSchema>;
export const firstPublishCardSchema = z.object({
  entityType: z.enum(['model', 'article']),
  id: z.number().int().positive(),
});
