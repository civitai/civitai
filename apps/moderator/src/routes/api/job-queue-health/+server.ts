import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getJobQueueHealth } from '$lib/server/job-queue.service';

// Client-fetched for the same reason as the moderation board: it is a grouped scan of every JobQueue
// row (~50ms, no index to use) and the dashboard's first paint should not wait on it.
//
// Requires a moderator session, like the dashboard's other endpoints. The payload is per-type row
// counts of background work with no user content in it, so it carries no narrower check.
export const GET: RequestHandler = async ({ locals }) => {
  if (!locals.user) return json(null, { status: 401 });
  return json(await getJobQueueHealth());
};
