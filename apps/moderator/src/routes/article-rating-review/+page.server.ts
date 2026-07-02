import { fail } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import {
  getArticleRatingReviews,
  getArticleRatingReviewCounts,
} from '$lib/server/article-rating-reviews.service';
import { resolveRatingReview } from '$lib/server/article-rating-review-actions';
import type { RatingReviewStatusFilter } from '$lib/article-rating-review';
import { validNsfwLevels } from '$lib/browsing-levels';

const LIMIT = 20;

const isStatus = (v: string | null): v is RatingReviewStatusFilter =>
  v === 'Pending' || v === 'Actioned' || v === 'Unactioned';

export const load: PageServerLoad = async ({ url }) => {
  const page = Math.max(1, Number(url.searchParams.get('page')) || 1);
  const statusParam = url.searchParams.get('status');
  const status = isStatus(statusParam) ? statusParam : 'Pending';

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
