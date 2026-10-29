import { json } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { isJobRequest } from '$lib/server/jobs-auth';
import { sendNotifications } from '$lib/server/notify/notify.service';
import { accessibleToday, sendBatch } from '$lib/server/notify/runtime';
import { fetchSilenceTypes } from '$lib/server/notify/silence-types';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async ({ request }) => {
  if (!isJobRequest(request)) return new Response(null, { status: 401 });
  try {
    const result = await sendNotifications(db, {
      now: new Date(),
      send: sendBatch,
      accessible: accessibleToday,
      silenceTypes: await fetchSilenceTypes(),
    });
    return json(result, {
      status: result.failed + result.unconfirmed > 0 || result.skipped ? 500 : 200,
    });
  } catch (error) {
    console.error('knights: notify failed', error);
    return json({ error: 'job failed' }, { status: 500 });
  }
};
