import { fail } from '@sveltejs/kit';
import { z } from 'zod';
import { RATING_REVIEW_ENTITY_TYPES } from '@civitai/shared/rating-review';
import type { Actions, PageServerLoad } from './$types';
import { getRatingReviewCounts, getRatingReviews } from '$lib/server/rating-reviews.service';
import { resolveRatingReviewAction } from '$lib/server/rating-review-actions';
import { parseQuery } from '$lib/server/query';

const LIMIT = 20;

const querySchema = z.object({
  page: z.coerce.number().int().min(1).catch(1),
  status: z.enum(['Pending', 'Actioned', 'Unactioned']).catch('Pending'),
  type: z.enum(RATING_REVIEW_ENTITY_TYPES).optional().catch(undefined),
});

export const load: PageServerLoad = async ({ url }) => {
  const { page, status, type } = parseQuery(url, querySchema);
  const [data, counts] = await Promise.all([
    getRatingReviews({ status, entityType: type, page, limit: LIMIT }),
    getRatingReviewCounts(type),
  ]);
  return { status, type: type ?? null, counts, ...data };
};

const resolveSchema = z.object({
  reviewId: z.coerce.number().int().positive(),
  appliedLevel: z.coerce.number().int().positive(),
  modComment: z
    .string()
    .trim()
    .max(1000)
    .optional()
    .transform((v) => v || undefined),
});

// Access is enforced globally (hooks.server.ts); the per-entity level rule is enforced in the service.
export const actions: Actions = {
  resolve: async ({ request, locals }) => {
    const parsed = resolveSchema.safeParse(Object.fromEntries(await request.formData()));
    if (!parsed.success) return fail(400, { error: 'Invalid resolution' });
    const result = await resolveRatingReviewAction({ ...parsed.data, userId: locals.user.id });
    if (!result.ok) return fail(409, { error: result.error });
    return { success: true, status: result.status };
  },
};
