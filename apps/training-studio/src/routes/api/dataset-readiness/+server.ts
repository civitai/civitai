import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireToken } from '$lib/server/token';
import { blobHead, orchestratorClient } from '$lib/server/orchestrator';
import { claimDailyReturnable } from '$lib/server/dataset-rating';
import { isUploadReadinessOn } from '$lib/server/flipt';
import { logToAxiom, safeError } from '$lib/server/axiom';
import { isDatasetBlobIds } from '$lib/orchestrator-core';
import { trainingDataReady, type TrainingRunInput } from '$lib/train-core';
import {
  probeBlobReadiness,
  type ReadinessCheck,
  type ReadinessProbe,
} from '$lib/upload-readiness';

// `enabled: false` (switched off, past today's allowance, or anything unexpected) means Review doesn't
// wait, and the submit's own refusal is all that's left.
export const POST: RequestHandler = async ({ locals, request }) => {
  if (!(await isUploadReadinessOn(locals.user)))
    return json({ enabled: false } satisfies ReadinessProbe);

  const body = (await request.json().catch(() => null)) as {
    blobIds?: unknown;
    run?: unknown;
  } | null;

  if (body?.run !== undefined) {
    if (!body.run || typeof body.run !== 'object') error(400, 'Bad dataset readiness request.');
    if ((await claimDailyReturnable('probes', locals.user.id, 1)).granted === 0)
      return json({ enabled: false } satisfies ReadinessCheck);
    const token = await requireToken(locals, 'Training is unavailable right now.');
    const ready = await trainingDataReady(
      orchestratorClient(token),
      body.run as TrainingRunInput
    ).catch(() => null);
    if (ready === false)
      void logToAxiom({
        name: 'training-studio-upload-readiness',
        type: 'info',
        message: 'dataset not ready to train',
        userId: locals.user.id,
      });
    return json({ enabled: true, ready } satisfies ReadinessCheck);
  }

  if (!isDatasetBlobIds(body?.blobIds) || body.blobIds.length === 0)
    error(400, 'Bad dataset readiness request.');
  const blobIds = [...new Set(body.blobIds)];
  const allowance = await claimDailyReturnable('probes', locals.user.id, blobIds.length);
  if (allowance.granted < blobIds.length) {
    await allowance.giveBack(allowance.granted);
    return json({ enabled: false } satisfies ReadinessProbe);
  }
  const head = blobHead(await requireToken(locals, 'Training is unavailable right now.'));
  if (!head) {
    await allowance.giveBack(blobIds.length);
    return json({ enabled: false } satisfies ReadinessProbe);
  }
  try {
    const states = await probeBlobReadiness(head, blobIds);
    await allowance.giveBack(blobIds.length - Object.keys(states).length);
    return json({ enabled: true, states } satisfies ReadinessProbe);
  } catch (err) {
    await allowance.giveBack(blobIds.length);
    void logToAxiom({
      name: 'training-studio-upload-readiness',
      type: 'error',
      message: 'dataset readiness probe failed',
      userId: locals.user.id,
      error: safeError(err),
    });
    return json({ enabled: false } satisfies ReadinessProbe);
  }
};
