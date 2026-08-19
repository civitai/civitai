import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireUserIdParam } from '$lib/server/api-guard';
import { getUserNotifications } from '$lib/server/user-account.service';

// Split out of /api/user-account so Retool's "Number of Notifs" can change the fetch without pulling
// the other twelve queries with it. The service already returns null (not an error) when the
// notifications service is unreachable, which the panel renders as "unavailable" rather than "none".
export const GET: RequestHandler = async ({ params, url, locals }) => {
  const userId = requireUserIdParam(locals, params, '/retool/user-lookup');

  const requested = Number(url.searchParams.get('limit'));
  const limit = Number.isInteger(requested) && requested > 0 && requested <= 200 ? requested : 25;

  return json(await getUserNotifications(userId, limit));
};
