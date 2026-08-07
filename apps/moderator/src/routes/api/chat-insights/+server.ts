import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireAccess } from '$lib/server/access';
import { getChatStats, getSpamGroups } from '$lib/server/chat-insights.service';

// Platform-wide aggregates and spam detection, off the page load: every query here scans the 4.2M-row
// ChatMessage table (~500-700ms each, run together).
//
// No id parameter, so this checks access directly rather than through requireIdParam — `/api/*` is
// exempt from the global route gate.
export const GET: RequestHandler = async ({ locals }) => {
  if (!locals.user) error(403, 'Not signed in.');
  requireAccess(locals.user, '/retool/chat-audit');

  const [stats, spam] = await Promise.all([getChatStats(), getSpamGroups()]);
  return json({ stats, spam });
};
