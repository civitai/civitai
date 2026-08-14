import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { canAccess } from '$lib/server/access';
import { getMinorQueueCounts } from '$lib/server/minor-hash.service';
import { MINOR_HASH_PATH } from '../../models/minor-hash-matches/tabs';

// Client-fetched: the Pending count costs ~10s and must not sit in the page's render path.
export const GET: RequestHandler = async ({ locals }) => {
  if (!locals.user || !canAccess(locals.user, MINOR_HASH_PATH))
    return json({ error: 'No access.' }, { status: 403 });
  return json(await getMinorQueueCounts());
};
