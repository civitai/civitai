import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireUserIdParam } from '$lib/server/api-guard';
import {
  getModerationFlags,
  getUserNotes,
  getUserStrikes,
} from '$lib/server/moderation-memory.service';
import { getLiveStrikes } from '$lib/server/user-lookup.service';

// Notes and strikes come from the MODERATOR database — a second connection, so it is fetched
// client-side rather than made part of the page load's critical path.
export const GET: RequestHandler = async ({ params, locals }) => {
  const userId = requireUserIdParam(locals, params, '/retool/user-lookup');

  const [notes, strikes, liveStrikes, flags] = await Promise.all([
    getUserNotes(userId, locals.user.username ?? null),
    getUserStrikes(userId),
    // Caught rather than left to reject: the one call here that crosses to the MAIN database, and a
    // shared rejection would take the notes and account flags down with it. `null` so the panel can
    // say "could not check" — an empty array would assert the account is clean.
    getLiveStrikes(userId, { readYourWrite: true }).catch(() => null),
    getModerationFlags(userId),
  ]);

  return json({ notes, strikes, liveStrikes, flags });
};
