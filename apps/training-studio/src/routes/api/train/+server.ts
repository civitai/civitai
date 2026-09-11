import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireToken } from '$lib/server/token';
import { submitTrainingBatch, type TrainingRunInput } from '$lib/server/train';
import { TrainingBatchValidationError } from '$lib/train-core';

// Submit the real training workflow(s) — one per run — and return their ids. This spends Buzz, so it's
// the single write in the whole flow. HTTP mapping over core.submitTrainingBatch: a refused batch is a
// 400; a batch where nothing landed is a 502 (safe to retry whole); a partial batch returns the landed
// ids with 200 so the client navigates to them instead of re-submitting — and re-charging — them.
export const POST: RequestHandler = async ({ locals, request }) => {
  const token = await requireToken(
    locals,
    'Training is unavailable right now — no orchestrator token.'
  );

  const body = (await request.json().catch(() => null)) as { runs?: TrainingRunInput[] } | null;
  const runs = body?.runs;
  let workflowIds: string[];
  try {
    workflowIds = await submitTrainingBatch(token, runs, locals.user.id);
  } catch (err) {
    if (err instanceof TrainingBatchValidationError) error(400, 'Bad training request.');
    error(502, 'Could not start training. Try again.');
  }

  return json({ workflowIds, requested: runs?.length ?? 0 });
};
