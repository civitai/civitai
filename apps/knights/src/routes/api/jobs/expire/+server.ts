import { json } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { isJobRequest } from '$lib/server/jobs-auth';
import { applyPendingResolutions, escalateExpired } from '$lib/server/queue/queue.service';
import { queueDeps } from '$lib/server/queue/runtime';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async ({ request }) => {
  if (!isJobRequest(request)) return new Response(null, { status: 401 });
  const expired = await escalateExpired(db, { now: new Date() });
  const writeBacks = await applyPendingResolutions(db, queueDeps);
  return json({ ...expired, ...writeBacks });
};
