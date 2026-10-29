import { json } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { isJobRequest } from '$lib/server/jobs-auth';
import { applyPendingResolutions, escalateExpired } from '$lib/server/queue/queue.service';
import { settleFinalItems } from '$lib/server/progression/progression';
import { queueDeps } from '$lib/server/queue/runtime';
import { resetDeps } from '$lib/server/smites/runtime';
import { expireSmites, resetPendingPlayers } from '$lib/server/smites/smites.service';
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
  const progression = await settle('progression', () =>
    settleFinalItems(db, { now: new Date(), mirror: queueDeps.mirrorXp })
  );
  const smites = await settle('smite expiry', () => expireSmites(db, new Date()));
  const resets = await settle('career resets', () => resetPendingPlayers(db, resetDeps));
  if (
    !expired.ok ||
    !writeBacks.ok ||
    !progression.ok ||
    progression.value.failed > 0 ||
    !smites.ok ||
    !resets.ok ||
    resets.value.failed > 0
  ) {
    return json({ error: 'job failed' }, { status: 500 });
  }
  return json({
    ...expired.value,
    ...writeBacks.value,
    settledVotes: progression.value.votes,
    expiredSmites: smites.value,
    resets: resets.value.due,
  });
};
