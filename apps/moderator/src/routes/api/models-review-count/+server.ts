import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { canAccess } from '$lib/server/access';
import { getModelsNeedingReview } from '$lib/server/moderation-board.service';

// Client-fetched: the count has no index and runs ~2.7s, so it must not sit in the dashboard's render
// path. `/api/*` is exempt from the global route gate, so this checks access itself.
export const GET: RequestHandler = async ({ locals }) => {
  if (!locals.user || !canAccess(locals.user, '/reports')) return json({ count: null });
  return json({ count: await getModelsNeedingReview() });
};
