import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireUserIdParam } from '$lib/server/api-guard';
import { getModActivity, getRetoolActivity } from '$lib/server/user-account.service';

// Fetched client-side like the security signals: four indexed queries plus a moderator-name lookup, which
// is cheap individually but not worth adding to the identity render path.
export const GET: RequestHandler = async ({ params, locals }) => {
  const userId = requireUserIdParam(locals, params, '/retool/user-lookup');

  // Two eras, fetched together but kept apart in the payload: `ModActivity` has entity links and a real
  // moderator id; the Retool rows have neither, and merging them would imply a continuity that the
  // data does not have.
  const [current, retool] = await Promise.all([getModActivity(userId), getRetoolActivity(userId)]);
  return json({ current, retool });
};
