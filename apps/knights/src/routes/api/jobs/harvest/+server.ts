import { json } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import { db } from '$lib/server/db';
import { isJobRequest } from '$lib/server/jobs-auth';
import { metrics } from '$lib/server/metrics';
import { hiddenSettings } from '$lib/server/hidden/runtime';
import { storedSettings } from '$lib/server/settings/runtime';
import { harvestSettings } from '$lib/server/trials/config';
import { runHarvestJob } from '$lib/server/trials/harvest.service';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async ({ request }) => {
  if (!isJobRequest(request)) return new Response(null, { status: 401 });
  try {
    // Read per run so a changed environment or a value saved on the moderator Config page is picked up without a rebuild.
    const settings = harvestSettings(env, await storedSettings());
    if (settings.unrecognized !== undefined) {
      console.warn(
        `knights: KNIGHTS_HARVEST="${settings.unrecognized}" is not on/true/1 or off/false/0; paused`
      );
    }
    const { probationShare } = await hiddenSettings();
    const result = await runHarvestJob(db, { now: new Date(), settings, probationShare });
    if ('skippedStale' in result && result.skippedStale > 0) {
      console.warn(`knights: harvest skipped ${result.skippedStale} rulings older than its window`);
      metrics.harvestSkipped(result.skippedStale);
    }
    return json(result);
  } catch (error) {
    console.error('knights: harvest failed', error);
    return json({ error: 'job failed' }, { status: 500 });
  }
};
