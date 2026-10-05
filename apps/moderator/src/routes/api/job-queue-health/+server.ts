import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getJobQueueHealth } from '$lib/server/job-queue.service';

// Client-fetched for the same reason as the moderation board: it is a grouped scan of every JobQueue
// row (~50ms, no index to use) and the dashboard's first paint should not wait on it.
//
// Route access is gated in hooks.server.ts. The payload is per-type row counts of background work with
// no user content in it, so it carries no narrower check of its own.
export const GET: RequestHandler = async () => json(await getJobQueueHealth());
