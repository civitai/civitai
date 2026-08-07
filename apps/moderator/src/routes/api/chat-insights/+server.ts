import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireAccess } from '$lib/server/access';
import { getChatStats, getNewestMessages, getSpamGroups } from '$lib/server/chat-insights.service';

// Platform-wide aggregates and spam detection, off the page load: every query here scans the 4.2M-row
// ChatMessage table (~500-700ms each, run together).
//
// No id parameter, so this checks access directly rather than through requireIdParam — `/api/*` is
// exempt from the global route gate.
export const GET: RequestHandler = async ({ locals }) => {
  if (!locals.user) error(403, 'Not signed in.');
  requireAccess(locals.user, '/retool/chat-audit');

  // allSettled, not all: the spam grouping is the slowest of the three and a statement timeout on it
  // must not take the live message feed down with it. Each section reports its own failure.
  const [stats, spam, newest] = await Promise.allSettled([
    getChatStats(),
    getSpamGroups(),
    getNewestMessages(),
  ]);
  const value = <T>(r: PromiseSettledResult<T>) => (r.status === 'fulfilled' ? r.value : null);
  return json({ stats: value(stats), spam: value(spam), newest: value(newest) });
};
