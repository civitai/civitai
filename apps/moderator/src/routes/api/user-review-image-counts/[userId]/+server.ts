import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireUserIdParam } from '$lib/server/api-guard';
import { getReviewImageCounts } from '$lib/server/user-account.service';

// Its own endpoint so a slow count cannot hold up `/api/user-account` — see `getReviewImageCounts`.
export const GET: RequestHandler = async ({ params, locals }) => {
  const userId = requireUserIdParam(locals, params, '/retool/user-lookup');
  return json(await getReviewImageCounts(userId));
};
