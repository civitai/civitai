import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { canAccess } from '$lib/server/access';
import { getModActivity } from '$lib/server/user-lookup.service';

// Fetched client-side like the security signals: four indexed queries plus a moderator-name lookup, which
// is cheap individually but not worth adding to the identity render path.
//
// `/api/*` is exempt from the global route gate, so this checks page access itself.
export const GET: RequestHandler = async ({ params, locals }) => {
  if (!locals.user || !canAccess(locals.user, '/retool/user-lookup'))
    return json({ error: 'forbidden' }, { status: 403 });

  const userId = Number(params.userId);
  if (!Number.isInteger(userId) || userId <= 0)
    return json({ error: 'bad userId' }, { status: 400 });

  return json(await getModActivity(userId));
};
