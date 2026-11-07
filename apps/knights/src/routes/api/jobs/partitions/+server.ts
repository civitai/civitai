import { json } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { isJobRequest } from '$lib/server/jobs-auth';
import { ensureVotePartitions } from '$lib/server/queue/queue.service';
import type { RequestHandler } from './$types';

const MONTHS_AHEAD = 2;

export const POST: RequestHandler = async ({ request }) => {
  if (!isJobRequest(request)) return new Response(null, { status: 401 });
  await ensureVotePartitions(db, { now: new Date(), monthsAhead: MONTHS_AHEAD });
  return json({ ok: true });
};
