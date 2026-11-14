import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireToken } from '$lib/server/token';
import { submitTrainingBatch, type TrainingRunInput } from '$lib/server/train';
import {
  MatureAckRequiredError,
  TrainingBatchValidationError,
  TrainingSubmitError,
  type SubmittedBatch,
} from '$lib/train-core';
import { textCheckCookie, throwTextCheckHttpError } from '$lib/server/text-check';
import { datasetRatingFor } from '$lib/server/dataset-rating';
import { FILES_PROCESSING_CODE, FilesProcessingError } from '$lib/files-processing';

// Submit the real training workflow(s) — one per run — and return their ids. This spends Buzz, so it's
// the single write in the whole flow. HTTP mapping over core.submitTrainingBatch: a batch refused by us or
// by the orchestrator (a non-transient 4xx) is a 400 carrying the reason, since a retry would be refused
// the same way — except dataset files still processing, a 400 with `code: FILES_PROCESSING_CODE` that
// clears on its own, so the client offers a retry; a batch where nothing landed otherwise is a 502 (safe
// to retry whole); a partial batch returns the landed ids and the failure's reason with 200, so the
// client navigates to them instead of re-submitting — and re-charging — them.
export const POST: RequestHandler = async ({ locals, request }) => {
  const token = await requireToken(
    locals,
    'Training is unavailable right now — no orchestrator token.'
  );

  const body = (await request.json().catch(() => null)) as { runs?: TrainingRunInput[] } | null;
  const runs = body?.runs;
  let batch: SubmittedBatch;
  try {
    batch = await submitTrainingBatch(
      token,
      runs,
      locals.user.id,
      textCheckCookie(locals, request),
      await datasetRatingFor(locals.user)
    );
  } catch (err) {
    if (err instanceof TrainingBatchValidationError) error(400, err.message);
    if (err instanceof MatureAckRequiredError)
      error(409, { message: err.message, matureCount: err.matureCount });
    throwTextCheckHttpError(err);
    if (err instanceof FilesProcessingError)
      error(400, { message: err.message, code: FILES_PROCESSING_CODE });
    if (err instanceof TrainingSubmitError && err.isRefusal)
      error(400, `Training could not start: ${err.reason}`);
    if (err instanceof TrainingSubmitError && err.status !== undefined && err.status < 500)
      error(502, `Could not start training: ${err.reason}. Try again.`);
    // Not "try again": the run may have started and charged anyway. The server already looked for
    // it by the batch's submit key; a Start of the same batch reuses that key, so it returns a run
    // that landed instead of charging twice, but the user should look before starting over.
    error(
      502,
      "We couldn't confirm your training started. Check your runs before starting it again; starting this same batch again won't charge twice."
    );
  }

  return json({ ...batch, requested: runs?.length ?? 0 });
};
