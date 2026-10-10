import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireToken } from '$lib/server/token';
import { submitTrainingBatch, type TrainingRunInput } from '$lib/server/train';
import {
  TrainingBatchValidationError,
  TrainingSubmitError,
  type SubmittedBatch,
} from '$lib/train-core';

// Submit the real training workflow(s) — one per run — and return their ids. This spends Buzz, so it's
// the single write in the whole flow. HTTP mapping over core.submitTrainingBatch: a batch refused by us or
// by the orchestrator (a non-transient 4xx) is a 400 carrying the reason, since a retry would be refused
// the same way; a batch where nothing landed otherwise is a 502 (safe to retry whole); a partial batch
// returns the landed ids and the failure's reason with 200, so the client navigates to them instead of
// re-submitting — and re-charging — them.
export const POST: RequestHandler = async ({ locals, request }) => {
  const token = await requireToken(
    locals,
    'Training is unavailable right now — no orchestrator token.'
  );

  const body = (await request.json().catch(() => null)) as { runs?: TrainingRunInput[] } | null;
  const runs = body?.runs;
  let batch: SubmittedBatch;
  try {
    batch = await submitTrainingBatch(token, runs, locals.user.id);
  } catch (err) {
    if (err instanceof TrainingBatchValidationError) error(400, err.message);
    if (err instanceof TrainingSubmitError && err.isRefusal)
      error(400, `Training could not start: ${err.reason}`);
    if (err instanceof TrainingSubmitError && err.status !== undefined && err.status < 500)
      error(502, `Could not start training: ${err.reason}. Try again.`);
    error(502, 'Could not start training. Try again.');
  }

  return json({ ...batch, requested: runs?.length ?? 0 });
};
