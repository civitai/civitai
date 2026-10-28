import { json } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { isJobRequest } from '$lib/server/jobs-auth';
import { applyPendingResolutions, escalateExpired } from '$lib/server/queue/queue.service';
import { queueDeps } from '$lib/server/queue/runtime';
import type { RequestHandler } from './$types';

async function settle<T>(step: string, run: () => Promise<T>) {
  try {
    return { ok: true as const, value: await run() };
  } catch (error) {
    console.error(`knights: ${step} failed`, error);
    return { ok: false as const };
  }
}

export const POST: RequestHandler = async ({ request }) => {
  if (!isJobRequest(request)) return new Response(null, { status: 401 });

  const expired = await settle('escalation', () => escalateExpired(db, { now: new Date() }));
  const writeBacks = await settle('rating write-back', () =>
    applyPendingResolutions(db, queueDeps)
  );
  if (!expired.ok || !writeBacks.ok) {
    return json({ error: 'job failed' }, { status: 500 });
  }
  return json({ ...expired.value, ...writeBacks.value });
};
