import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { canAccess } from '$lib/server/access';
import { getMinorQueueCounts } from '$lib/server/minor-hash.service';
import { FLAG_APPEALS_PATH, MINOR_HASH_PATH } from '$lib/minor-flags/paths';

// Client-fetched: the Pending count costs ~10s and must not sit in the page's render path.
export const GET: RequestHandler = async ({ locals }) => {
  if (
    !locals.user ||
    !(canAccess(locals.user, MINOR_HASH_PATH) || canAccess(locals.user, FLAG_APPEALS_PATH))
  )
    return json({ error: 'No access.' }, { status: 403 });
  return json(await getMinorQueueCounts());
};
