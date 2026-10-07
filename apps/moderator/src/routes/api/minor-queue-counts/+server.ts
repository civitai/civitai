import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { canAccessMinorQueue } from '$lib/server/minor-queue-access';
import { getMinorQueueCounts } from '$lib/server/minor-hash.service';

// Client-fetched: the Pending count costs ~10s and must not sit in the page's render path.
export const GET: RequestHandler = async ({ locals }) => {
  if (!locals.user || !canAccessMinorQueue(locals.user))
    return json({ error: 'No access.' }, { status: 403 });
  return json(await getMinorQueueCounts());
};
