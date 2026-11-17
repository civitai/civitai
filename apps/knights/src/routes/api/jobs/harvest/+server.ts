import { json } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import { db } from '$lib/server/db';
import { isJobRequest } from '$lib/server/jobs-auth';
import { harvestSettings } from '$lib/server/trials/config';
import { runHarvestJob } from '$lib/server/trials/harvest.service';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async ({ request }) => {
  if (!isJobRequest(request)) return new Response(null, { status: 401 });
  try {
    // Read per run so a changed environment is picked up without a rebuild.
    return json(await runHarvestJob(db, { now: new Date(), settings: harvestSettings(env) }));
  } catch (error) {
    console.error('knights: harvest failed', error);
    return json({ error: 'job failed' }, { status: 500 });
  }
};
