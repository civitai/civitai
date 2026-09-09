import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireToken } from '$lib/server/token';
import { continueTraining, continueTrainingWhatIf, type ContinueOpts } from '$lib/server/train';

function parse(v: string | null): number | null {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Quote a "keep training" continuation without charging — for the price + confirm before submit. */
export const GET: RequestHandler = async ({ locals, url }) => {
  const workflowId = url.searchParams.get('id');
  const fromEpoch = parse(url.searchParams.get('fromEpoch'));
  const addEpochs = parse(url.searchParams.get('addEpochs'));
  if (!workflowId || fromEpoch === null || addEpochs === null) error(400, 'Bad request.');
  const opts: ContinueOpts = {
    workflowId,
    fromEpoch,
    addEpochs: Math.min(20, Math.max(1, Math.round(addEpochs))),
  };
  const token = await requireToken(locals, 'Pricing is unavailable right now.');
  try {
    return json(await continueTrainingWhatIf(token, locals.user.id, opts));
  } catch (err) {
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
  } | null;
  if (!body?.workflowId || typeof body.fromEpoch !== 'number' || typeof body.addEpochs !== 'number')
    error(400, 'Bad request.');
  const opts: ContinueOpts = {
    workflowId: body.workflowId,
    fromEpoch: body.fromEpoch,
    addEpochs: Math.min(20, Math.max(1, Math.round(body.addEpochs))),
  };

  const token = await requireToken(locals, 'Training is unavailable right now.');
  try {
    return json({ workflowId: await continueTraining(token, locals.user.id, opts) });
  } catch (err) {
    console.warn('[training-studio] continueTraining failed', err);
    error(502, err instanceof Error ? err.message : 'Could not start training.');
  }
};
