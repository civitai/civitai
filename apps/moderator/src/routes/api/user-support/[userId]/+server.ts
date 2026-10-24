import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireUserIdParam } from '$lib/server/api-guard';
import { getFreshdeskContact } from '$lib/server/freshdesk.service';
import { getTimedMute } from '$lib/server/user-actions.service';
import { dbRead } from '$lib/server/db';

// The account's timed mute and the Freshdesk contact (external HTTP) — both off the page load.
export const GET: RequestHandler = async ({ params, locals }) => {
  const userId = requireUserIdParam(locals, params, '/retool/user-lookup');

  const user = await dbRead
    .selectFrom('User')
    .select('email')
    .where('id', '=', userId)
    .executeTakeFirst();

  const [timedMute, freshdesk] = await Promise.all([
    getTimedMute(userId),
    getFreshdeskContact(user?.email ?? null),
  ]);

  return json({ timedMute, freshdesk });
};
