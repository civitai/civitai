import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireUserIdParam } from '$lib/server/api-guard';
import {
  getBuzzBalance,
  getComments,
  getCosmetics,
  getReactionTargets,
  getReviews,
} from '$lib/server/user-lookup.service';

// Client-fetched: the Buzz balance is an external HTTP call and the three lists are only wanted once an
// investigation is already underway. Keeping them off the load means identity still renders immediately.
export const GET: RequestHandler = async ({ params, locals }) => {
  const userId = requireUserIdParam(locals, params, '/retool/user-lookup');

  const [buzz, reviews, comments, cosmetics, reactions] = await Promise.all([
    getBuzzBalance(userId),
    getReviews(userId),
    getComments(userId),
    getCosmetics(userId),
    getReactionTargets(userId),
  ]);

  return json({ buzz, reviews, comments, cosmetics, reactions });
};
