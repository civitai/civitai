import { fail } from '@sveltejs/kit';
import { z } from 'zod';
import type { Actions, PageServerLoad } from './$types';
import {
  getArticleRatingReviews,
  getArticleRatingReviewCounts,
} from '$lib/server/article-rating-reviews.service';
import { resolveRatingReview } from '$lib/server/article-rating-review-actions';
import { validNsfwLevels } from '$lib/browsing-levels';
import { parseQuery } from '$lib/server/query';

const LIMIT = 20;

const querySchema = z.object({
  page: z.coerce.number().int().min(1).catch(1),
  // Absent / invalid → the default Pending bucket.
  status: z.enum(['Pending', 'Actioned', 'Unactioned']).catch('Pending'),
});

export const load: PageServerLoad = async ({ url }) => {
  const { page, status } = parseQuery(url, querySchema);

  const [data, counts] = await Promise.all([
    getArticleRatingReviews({ status, page, limit: LIMIT }),
    getArticleRatingReviewCounts(),
  ]);

  return { status, counts, ...data };
};

// Access is enforced globally (hooks.server.ts), so locals.user is a moderator here.
export const actions: Actions = {
  resolve: async ({ request, locals }) => {
    const form = await request.formData();
    const reviewId = Number(form.get('reviewId'));
    const appliedLevel = Number(form.get('appliedLevel'));
    const modComment = String(form.get('modComment') ?? '').trim() || undefined;

    if (!reviewId) return fail(400, { error: 'Missing review id' });
    if (!validNsfwLevels.has(appliedLevel)) return fail(400, { error: 'Invalid rating level' });

    const result = await resolveRatingReview({
      reviewId,
      appliedLevel,
      modComment,
      userId: locals.user.id,
    });
    if (!result.ok) return fail(502, { error: result.error });
    return { success: true, status: result.status };
  },
};
