import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireUserIdParam } from '$lib/server/api-guard';
import { getModActivity } from '$lib/server/user-account.service';

// Fetched client-side like the security signals: four indexed queries plus a moderator-name lookup, which
// is cheap individually but not worth adding to the identity render path.
export const GET: RequestHandler = async ({ params, locals }) => {
  const userId = requireUserIdParam(locals, params, '/retool/user-lookup');

  return json(await getModActivity(userId));
};
