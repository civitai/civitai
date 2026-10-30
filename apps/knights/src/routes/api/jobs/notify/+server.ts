import { json } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { isJobRequest } from '$lib/server/jobs-auth';
import { logToAxiom } from '$lib/server/axiom';
import { sendNotifications } from '$lib/server/notify/notify.service';
import { accessibleToday, sendBatch } from '$lib/server/notify/runtime';
import { env } from '$env/dynamic/private';
import { notificationsConfigured } from '$lib/server/notify/sender';
import { fetchSilenceTypes } from '$lib/server/notify/silence-types';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async ({ request }) => {
  if (!isJobRequest(request)) return new Response(null, { status: 401 });
  if (!notificationsConfigured(env)) {
    console.error('knights: NOTIFICATIONS_ENDPOINT / NOTIFICATIONS_TOKEN are not configured');
    return json({ error: 'notifications not configured' }, { status: 500 });
  }
  try {
    const result = await sendNotifications(db, {
      now: new Date(),
      send: sendBatch,
      accessible: accessibleToday,
      silenceTypes: await fetchSilenceTypes(),
    });
    if (result.accessUnknown) {
      console.warn('knights: access flag unavailable; only moderators were notified');
      void logToAxiom({ type: 'warning', name: 'knights-notify-access-unknown' });
    }
    const incomplete =
      result.failed + result.unconfirmed + result.confirmFailed > 0 ||
      result.skipped ||
      result.accessUnknown;
    return json(result, { status: incomplete ? 500 : 200 });
  } catch (error) {
    console.error('knights: notify failed', error);
    return json({ error: 'job failed' }, { status: 500 });
  }
};
