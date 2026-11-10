import * as z from 'zod';
import { logToAxiom } from '~/server/logging/client';
import { REDIS_SYS_KEYS, sysRedis, withSysReadDeadline } from '~/server/redis/client';

export const THEME_REVIEW_MODES = ['shadow', 'flag', 'enforce'] as const;
export type ThemeReviewMode = (typeof THEME_REVIEW_MODES)[number];

const reviewSchema = z.object({
  theme: z.string().min(1),
  themeElements: z.array(z.string().min(1)).default([]),
  judgeId: z.number().int().positive(),
  mode: z.enum(THEME_REVIEW_MODES),
  // Replaces the judge's review prompt for this crucible.
  reviewPrompt: z.string().min(1).optional(),
});
const configSchema = z.object({ crucibles: z.record(z.string().regex(/^\d+$/), reviewSchema) });
export type CrucibleThemeReview = z.infer<typeof reviewSchema> & { crucibleId: number };

/**
 * Operator-set from sysRedis; the prompts stay out of the repo. An unreadable config is `null`: it
 * reviews nothing, and nothing may treat a crucible as unreviewed because of it.
 */
export async function getCrucibleThemeReviews(): Promise<CrucibleThemeReview[] | null> {
  const raw = await withSysReadDeadline(sysRedis.get(REDIS_SYS_KEYS.SYSTEM.CRUCIBLE_THEME_REVIEW));
  if (!raw) return [];
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    json = undefined;
  }
  const parsed = configSchema.safeParse(json);
  if (!parsed.success) {
    logToAxiom({
      type: 'error',
      name: 'crucible-theme-review-config-invalid',
      message: parsed.error.message,
    });
    return null;
  }
  return Object.entries(parsed.data.crucibles).map(([id, review]) => ({
    ...review,
    crucibleId: Number(id),
  }));
}
