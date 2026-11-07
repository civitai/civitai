import { fail } from '@sveltejs/kit';
import { z } from 'zod';
import type { Actions, PageServerLoad } from './$types';
import { requireAccess } from '$lib/server/access';
import { int4Id, parseForm } from '$lib/server/query';
import {
  blockLinkReview,
  clearLinkReview,
  getLinkReviews,
  LINK_REVIEW_LIMIT,
  LINK_REVIEW_STATUSES,
  type LinkReviewStatus,
} from '$lib/server/knights/link-review.service';

const idForm = z.object({ id: int4Id });

export const load: PageServerLoad = async ({ url, locals }) => {
  requireAccess(locals.user, url.pathname);
  const requested = url.searchParams.get('status');
  const status: LinkReviewStatus = LINK_REVIEW_STATUSES.find((s) => s === requested) ?? 'Pending';
  return { status, limit: LINK_REVIEW_LIMIT, reviews: await getLinkReviews(status) };
};

export const actions: Actions = {
  block: async ({ request, locals, url }) => {
    requireAccess(locals.user, url.pathname);
    const input = parseForm(idForm, await request.formData());
    if (typeof input === 'string') return fail(400, { error: input });
    const result = await blockLinkReview(input.id, locals.user.id);
    return result.ok ? { success: true } : fail(409, { error: result.error });
  },

  clear: async ({ request, locals, url }) => {
    requireAccess(locals.user, url.pathname);
    const input = parseForm(idForm, await request.formData());
    if (typeof input === 'string') return fail(400, { error: input });
    const result = await clearLinkReview(input.id, locals.user.id);
    return result.ok ? { success: true } : fail(409, { error: result.error });
  },
};
