import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireUserIdParam } from '$lib/server/api-guard';
import { getReviews, parseReviewQuery } from '$lib/server/user-account.service';

export const GET: RequestHandler = async ({ params, url, locals }) => {
  const userId = requireUserIdParam(locals, params, '/retool/user-lookup');
  return json(await getReviews(userId, parseReviewQuery(url.searchParams)));
};
