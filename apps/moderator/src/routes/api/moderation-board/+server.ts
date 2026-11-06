import { json } from '@sveltejs/kit';
import type { BoardResponse } from './types';
import type { RequestHandler } from './$types';
import {
  getRecentQueueActivity,
  getRecentModActivity,
  getSweepCounts,
  getTaskLag,
} from '$lib/server/moderation-board.service';
import { bounded } from '$lib/server/bounded';

// The non-count half of Retool's Moderation Status board. Client-fetched for the same reason as the
// sidebar counts and most-reported: a dozen per-type LIMIT 1 lookups plus a cross-database read do not
// belong in the dashboard's first paint.
//
// Requires a moderator session, like the dashboard's other endpoints. Everything here is a
// moderator-facing aggregate over data the dashboard already shows, so it carries no narrower check.
export const GET: RequestHandler = async ({ locals }) => {
  if (!locals.user) return json(null, { status: 401 });
  const [activity, modActivity, lag, sweeps] = await Promise.all([
    getRecentQueueActivity(),
    // Queues that resolve no report log only here, so the board is the union of the two. Bounded:
    // it reads a large window of an append-only log and the board must render without it.
    bounded(getRecentModActivity).then((r) => r ?? []),
    // The moderator database is separate infrastructure; it being down must degrade the strips that
    // depend on it rather than blank the board.
    getTaskLag().catch(() => []),
    getSweepCounts().catch(() => []),
  ]);

  const payload: BoardResponse = {
    activity: [...activity.values(), ...modActivity],
    lag,
    sweeps,
  };
  return json(payload);
};
