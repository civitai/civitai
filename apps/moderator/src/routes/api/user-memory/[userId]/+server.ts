import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { canAccess } from '$lib/server/access';
import { getUserNotes, getUserStrikes } from '$lib/server/moderation-memory.service';

// Notes and strikes come from the MODERATOR database — a second connection, so it is fetched
// client-side rather than made part of the page load's critical path.
//
// `/api/*` is exempt from the global route gate, so this checks page access itself.
export const GET: RequestHandler = async ({ params, locals }) => {
  if (!locals.user || !canAccess(locals.user, '/retool/user-lookup'))
    return json({ error: 'forbidden' }, { status: 403 });

  const userId = Number(params.userId);
  if (!Number.isInteger(userId) || userId <= 0)
    return json({ error: 'bad userId' }, { status: 400 });

  const [notes, strikes] = await Promise.all([
    getUserNotes(userId, locals.user.username ?? null),
    getUserStrikes(userId),
  ]);

  return json({ notes, strikes });
};
