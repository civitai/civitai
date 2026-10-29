import { json } from '@sveltejs/kit';
import { logToAxiom } from '$lib/server/axiom';
import { retryPendingConversions } from '$lib/server/conversion/convert';
import { runPostDetectionPass } from '$lib/server/conversion/pass';
import { TICK_CONVERSION_RETRY } from '$lib/server/conversion/config';
import { buzzConfigured, conversionEnabled, getBuzzPort } from '$lib/server/conversion/runtime';
import { db } from '$lib/server/db';
import { settleHiddenChecks } from '$lib/server/hidden/settle';
import { hiddenSettings } from '$lib/server/hidden/runtime';
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
  const hidden = await settle('hidden checks', () =>
    settleHiddenChecks(db, {
      now: new Date(),
      settings: hiddenSettings(),
      mirrorXp: queueDeps.mirrorXp,
      ...resetDeps,
    })
  );
  // Resets first: a smite that lapses must not drop a player out of a reset that is already due.
  const resets = await settle('career resets', () => resetPendingPlayers(db, resetDeps));
  const smites = await settle('smite expiry', () => expireSmites(db, new Date()));
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
    !hidden.ok ||
    !smites.ok ||
    !resets.ok ||
    resets.value.failed > 0 ||
    !conversions.ok ||
    !postDetection.ok
  ) {
    return json({ error: 'job failed' }, { status: 500 });
  }
  return json({
    ...expired.value,
    ...writeBacks.value,
    settledVotes: progression.value.votes,
    hiddenChecksGraded: hidden.value.graded,
    expiredSmites: smites.value,
    resets: resets.value.due,
    conversionsRetried: conversions.value.retried,
    postDetection: postDetection.value,
  });
};
