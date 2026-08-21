import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireAccess } from '$lib/server/access';
import { getImageCountsForUsers } from '$lib/server/report-triage.service';

// The queue's "N of M images left" column. Client-fetched because the `remaining` half cannot use the
// covering index and takes seconds over 50 accounts — in `load` it blanks the whole page behind it.
export const GET: RequestHandler = async ({ url, locals }) => {
  if (!locals.user) error(403, 'Not signed in.');
  requireAccess(locals.user, '/retool/user-reports');

  const ids = (url.searchParams.get('userIds') ?? '')
    .split(',')
    .map(Number)
    .filter((n) => Number.isInteger(n) && n > 0 && n <= 2_147_483_647);
  if (ids.length > 100) error(400, 'Too many ids.');

  const counts = await getImageCountsForUsers(ids);
  return json(Object.fromEntries(counts));
};
