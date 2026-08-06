import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { canAccess } from '$lib/server/access';
import {
  getBuzzBalance,
  getComments,
  getCosmetics,
  getReviews,
} from '$lib/server/user-lookup.service';

// Client-fetched: the Buzz balance is an external HTTP call and the three lists are only wanted once an
// investigation is already underway. Keeping them off the load means identity still renders immediately.
//
// `/api/*` is exempt from the global route gate, so this checks page access itself.
export const GET: RequestHandler = async ({ params, locals }) => {
  if (!locals.user || !canAccess(locals.user, '/retool/user-lookup'))
    return json({ error: 'forbidden' }, { status: 403 });

  const userId = Number(params.userId);
  if (!Number.isInteger(userId) || userId <= 0)
    return json({ error: 'bad userId' }, { status: 400 });

  const [buzz, reviews, comments, cosmetics] = await Promise.all([
    getBuzzBalance(userId),
    getReviews(userId),
    getComments(userId),
    getCosmetics(userId),
  ]);

  return json({ buzz, reviews, comments, cosmetics });
};
