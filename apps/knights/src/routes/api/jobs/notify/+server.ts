import { json } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { isJobRequest } from '$lib/server/jobs-auth';
import { sendNotifications } from '$lib/server/notify/notify.service';
import { sendBatch } from '$lib/server/notify/runtime';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async ({ request }) => {
  if (!isJobRequest(request)) return new Response(null, { status: 401 });
  try {
    const result = await sendNotifications(db, { now: new Date(), send: sendBatch });
    return json(result, { status: result.failed > 0 ? 500 : 200 });
  } catch (error) {
    console.error('knights: notify failed', error);
    return json({ error: 'job failed' }, { status: 500 });
  }
};
