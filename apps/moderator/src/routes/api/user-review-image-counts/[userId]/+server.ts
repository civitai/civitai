import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireUserIdParam } from '$lib/server/api-guard';
import { getReviewImageCounts, parseReviewQuery } from '$lib/server/user-account.service';

// Its own endpoint so a slow count cannot hold up the list — see `getReviewImageCounts`.
export const GET: RequestHandler = async ({ params, url, locals }) => {
  const userId = requireUserIdParam(locals, params, '/retool/user-lookup');
  return json(await getReviewImageCounts(userId, parseReviewQuery(url.searchParams)));
};
