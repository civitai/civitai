import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { canAccess } from '$lib/server/access';
import { getMinorQueueCounts } from '$lib/server/minor-hash.service';

// Client-fetched: the Pending count costs ~10s and must not sit in the page's render path.
export const GET: RequestHandler = async ({ locals }) => {
  if (!locals.user || !canAccess(locals.user, '/models/minor-hash-matches'))
    return json({ error: 'No access.' }, { status: 403 });
  return json(await getMinorQueueCounts());
};
