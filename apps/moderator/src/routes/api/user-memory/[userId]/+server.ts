import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireUserIdParam } from '$lib/server/api-guard';
import { getUserNotes, getUserStrikes } from '$lib/server/moderation-memory.service';

// Notes and strikes come from the MODERATOR database — a second connection, so it is fetched
// client-side rather than made part of the page load's critical path.
export const GET: RequestHandler = async ({ params, locals }) => {
  const userId = requireUserIdParam(locals, params, '/retool/user-lookup');

  const [notes, strikes] = await Promise.all([
    getUserNotes(userId, locals.user.username ?? null),
    getUserStrikes(userId),
  ]);

  return json({ notes, strikes });
};
