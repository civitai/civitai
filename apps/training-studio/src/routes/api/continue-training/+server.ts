import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireToken } from '$lib/server/token';
import {
  continueTraining,
  continueTrainingWhatIf,
  MatureAckRequiredError,
  type ContinueOpts,
} from '$lib/server/train';
import { TrainingBatchValidationError } from '$lib/train-core';
import { textCheckCookie, throwTextCheckHttpError } from '$lib/server/text-check';
import { datasetRatingFor } from '$lib/server/dataset-rating';
import { isKohyaAllowed } from '$lib/server/flipt';
import { assertNotWithheld, RunWithheldError } from '$lib/server/withheld';

function parse(v: string | null): number | null {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Quote a "keep training" continuation without charging — for the price + confirm before submit. */
export const GET: RequestHandler = async ({ locals, request, url }) => {
  const workflowId = url.searchParams.get('id');
  const fromEpoch = parse(url.searchParams.get('fromEpoch'));
  const addEpochs = parse(url.searchParams.get('addEpochs'));
  if (!workflowId || fromEpoch === null || addEpochs === null) error(400, 'Bad request.');
  const opts: ContinueOpts = {
    workflowId,
    fromEpoch,
    addEpochs,
    currencies: url.searchParams.getAll('currencies'),
  };
  const token = await requireToken(locals, 'Pricing is unavailable right now.');
  try {
    await assertNotWithheld(request.headers.get('cookie') ?? '', workflowId);
    return json(
      await continueTrainingWhatIf(
        token,
        locals.user.id,
        opts,
        await datasetRatingFor(locals.user),
        await isKohyaAllowed(locals)
      )
    );
  } catch (err) {
    if (err instanceof TrainingBatchValidationError) error(400, err.message);
    if (err instanceof RunWithheldError) error(403, err.message);
    console.warn('[training-studio] continue whatif failed', err);
    error(502, err instanceof Error ? err.message : 'Could not price the continuation.');
  }
};

// "Keep training": submit a new run continuing from a checkpoint of an existing run. Charges Buzz.
export const POST: RequestHandler = async ({ locals, request }) => {
  const body = (await request.json().catch(() => null)) as {
    workflowId?: string;
    fromEpoch?: number;
    addEpochs?: number;
    currencies?: string[];
    matureAck?: boolean;
  } | null;
  if (!body?.workflowId || typeof body.fromEpoch !== 'number' || typeof body.addEpochs !== 'number')
    error(400, 'Bad request.');
  const opts: ContinueOpts = {
    workflowId: body.workflowId,
    fromEpoch: body.fromEpoch,
    addEpochs: body.addEpochs,
    // Filtered + defaulted by resolveCurrencies core-side — never trusted from the wire.
    currencies: Array.isArray(body.currencies) ? body.currencies : undefined,
    matureAck: body.matureAck === true,
  };

  const token = await requireToken(locals, 'Training is unavailable right now.');
  try {
    await assertNotWithheld(request.headers.get('cookie') ?? '', body.workflowId);
    return json({
      workflowId: await continueTraining(
        token,
        locals.user.id,
        opts,
        textCheckCookie(locals, request),
        await datasetRatingFor(locals.user),
        await isKohyaAllowed(locals)
      ),
    });
  } catch (err) {
    if (err instanceof TrainingBatchValidationError) error(400, err.message);
    if (err instanceof RunWithheldError) error(403, err.message);
    if (err instanceof MatureAckRequiredError)
      error(409, { message: err.message, matureCount: err.matureCount });
    throwTextCheckHttpError(err);
    console.warn('[training-studio] continueTraining failed', err);
    error(502, err instanceof Error ? err.message : 'Could not start training.');
  }
};
