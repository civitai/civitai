import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { canAccess } from '$lib/server/access';
import { getFreshdeskContact } from '$lib/server/freshdesk.service';
import { getTimedMutes } from '$lib/server/user-actions.service';
import { dbRead } from '$lib/server/db';

// Timed mutes (moderator database) and the Freshdesk contact (external HTTP) — both off the page load.
//
// `/api/*` is exempt from the global route gate, so this checks page access itself.
export const GET: RequestHandler = async ({ params, locals }) => {
  if (!locals.user || !canAccess(locals.user, '/retool/user-lookup'))
    return json({ error: 'forbidden' }, { status: 403 });

  const userId = Number(params.userId);
  if (!Number.isInteger(userId) || userId <= 0)
    return json({ error: 'bad userId' }, { status: 400 });

  const user = await dbRead
    .selectFrom('User')
    .select('email')
    .where('id', '=', userId)
    .executeTakeFirst();

  const [timedMutes, freshdesk] = await Promise.all([
    getTimedMutes(userId),
    getFreshdeskContact(user?.email ?? null),
  ]);

  return json({ timedMutes, freshdesk });
};
