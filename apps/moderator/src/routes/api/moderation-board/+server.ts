import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import {
  getAutoBlockedUsers,
  getRecentQueueActivity,
  getTaskLag,
} from '$lib/server/moderation-board.service';

// The non-count half of Retool's Moderation Status board. Client-fetched for the same reason as the
// sidebar counts and most-reported: a dozen per-type LIMIT 1 lookups plus a cross-database read do not
// belong in the dashboard's first paint.
//
// Route access is gated in hooks.server.ts. Everything here is a moderator-facing aggregate over data
// the dashboard already shows, so it carries no narrower check of its own.
export const GET: RequestHandler = async () => {
  const [activity, lag, autoBlocked] = await Promise.all([
    getRecentQueueActivity(),
    // The moderator database is separate infrastructure; it being down must degrade the lag strip
    // rather than blank the board.
    getTaskLag().catch(() => []),
    getAutoBlockedUsers(),
  ]);

  return json({
    activity: Object.fromEntries(activity),
    lag,
    autoBlocked,
  });
};
