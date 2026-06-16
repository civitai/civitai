import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db/db';
import { mintUserSession } from '$lib/server/auth/session';
import { getOrProduceSessionUser } from '$lib/server/auth/session-producer';
import { readUserId } from '$lib/server/auth/request';

// POST /api/auth/impersonate — moderator impersonation. The ONLY authorization is that the requester's own
// session belongs to a MODERATOR (per the cutover decision: no internal token, no extra credential — mod
// status is the whole gate). Mints a session for the target stamped with `impersonatedBy = the moderator`, and
// RETURNS it; the caller (the main app's same-origin proxy) sets the cookie + writes the ModActivity audit.
// Does NOT touch the device account-set (impersonation is not a linked account). See cutover doc (F).
export const POST: RequestHandler = async ({ request, locals }) => {
  if (!locals.user) error(401, 'unauthorized');

  // Impersonation is full account takeover, so confirm the privilege is CURRENT straight from the DB rather
  // than trusting only `locals.user.isModerator` (a produced-cache value that could be stale after a demotion).
  const requester = await db
    .selectFrom('User')
    .where('id', '=', locals.user.id)
    .select('isModerator')
    .executeTakeFirst();
  if (!requester?.isModerator) error(403, 'moderator only');

  const userId = await readUserId(request);
  if (userId === locals.user.id) error(400, 'cannot impersonate self');

  const target = await getOrProduceSessionUser(userId);
  if (!target) error(404, 'no such user');

  const token = await mintUserSession(target, { impersonatedBy: locals.user.id });
  return json({ token, userId });
};
