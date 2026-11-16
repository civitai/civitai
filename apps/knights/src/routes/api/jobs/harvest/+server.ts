import { json } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { isJobRequest } from '$lib/server/jobs-auth';
import { harvestRulings } from '$lib/server/trials/harvest.service';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async ({ request }) => {
  if (!isJobRequest(request)) return new Response(null, { status: 401 });
  try {
    return json(await harvestRulings(db, { now: new Date() }));
  } catch (error) {
    console.error('knights: harvest failed', error);
    return json({ error: 'job failed' }, { status: 500 });
  }
};
