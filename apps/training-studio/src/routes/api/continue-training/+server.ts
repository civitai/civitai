import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireToken } from '$lib/server/token';
import { continueTraining } from '$lib/server/train';

// "Keep training": submit a new run continuing from a checkpoint of an existing run. Charges Buzz.
export const POST: RequestHandler = async ({ locals, request }) => {
  const body = (await request.json().catch(() => null)) as {
    workflowId?: string;
    fromEpoch?: number;
    addEpochs?: number;
  } | null;
  if (!body?.workflowId || typeof body.fromEpoch !== 'number' || typeof body.addEpochs !== 'number')
    error(400, 'Bad request.');
  const addEpochs = Math.min(20, Math.max(1, Math.round(body.addEpochs)));

  const token = await requireToken(locals, 'Training is unavailable right now.');
  try {
    const workflowId = await continueTraining(token, locals.user.id, {
      workflowId: body.workflowId,
      fromEpoch: body.fromEpoch,
      addEpochs,
    });
    return json({ workflowId });
  } catch (err) {
    console.warn('[training-studio] continueTraining failed', err);
    error(502, err instanceof Error ? err.message : 'Could not start training.');
  }
};
