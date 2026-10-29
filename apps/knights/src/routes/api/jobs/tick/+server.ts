import { json } from '@sveltejs/kit';
import { logToAxiom } from '$lib/server/axiom';
import { retryPendingConversions } from '$lib/server/conversion/convert';
import { runPostDetectionPass } from '$lib/server/conversion/pass';
import { TICK_CONVERSION_RETRY } from '$lib/server/conversion/config';
import { buzzConfigured, conversionEnabled, getBuzzPort } from '$lib/server/conversion/runtime';
import { db } from '$lib/server/db';
import { isJobRequest } from '$lib/server/jobs-auth';
import { applyPendingResolutions, escalateExpired } from '$lib/server/queue/queue.service';
import { settleFinalItems } from '$lib/server/progression/progression';
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
  const progression = await settle('progression', () =>
    settleFinalItems(db, { now: new Date(), mirror: queueDeps.mirrorXp })
  );
  const conversions = await settle('conversion retries', async () => {
    if (!conversionEnabled()) return { retried: 0, paid: 0, failed: 0 };
    if (!buzzConfigured()) {
      await logToAxiom({
        type: 'warning',
        name: 'knights-conversion-retries-skipped',
        message: 'BUZZ_ENDPOINT is not configured; unconfirmed conversions were not retried',
      });
      return { retried: 0, paid: 0, failed: 0 };
    }
    return retryPendingConversions(db, getBuzzPort(), {
      now: new Date(),
      log: logToAxiom,
      ...TICK_CONVERSION_RETRY,
    });
  });
  const postDetection = await settle('post-detection pass', () =>
    runPostDetectionPass(db, { now: new Date(), log: logToAxiom })
  );
  if (
    !expired.ok ||
    !writeBacks.ok ||
    !progression.ok ||
    progression.value.failed > 0 ||
    !conversions.ok ||
    !postDetection.ok
  ) {
    return json({ error: 'job failed' }, { status: 500 });
  }
  return json({
    ...expired.value,
    ...writeBacks.value,
    settledVotes: progression.value.votes,
    conversionsRetried: conversions.value.retried,
    postDetection: postDetection.value,
  });
};
