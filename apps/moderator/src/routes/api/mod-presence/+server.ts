import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import type { ModPresence } from './types';
import { getWorkingNow, getYouToday } from '$lib/server/moderation-board.service';
import { bounded } from '$lib/server/bounded';

// The dashboard's "Working now" and "You today". Its own endpoint: "You today" is per viewer, so it
// cannot share the board's payload or any cache keyed on nothing.
export const GET: RequestHandler = async ({ locals }) => {
  if (!locals.user) return json(null, { status: 401 });
  const [working, today] = await Promise.all([
    bounded(getWorkingNow),
    bounded(() => getYouToday(locals.user!.id)),
  ]);
  if (!working || !today) return json(null, { status: 503 });
  const payload: ModPresence = { working, today };
  return json(payload);
};
