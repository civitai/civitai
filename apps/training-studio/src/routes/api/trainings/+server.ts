import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireToken } from '$lib/server/token';
import { listTrainingWorkflows } from '$lib/server/orchestrator';
import { deleteTraining } from '$lib/server/train';
import { DeleteRefusedError } from '$lib/train-core';

// The caller's training runs, for the "reuse a dataset" picker in the Data step.
export const GET: RequestHandler = async ({ locals }) => {
  if (locals.devPreview) return json([]);
  const token = await requireToken(locals, 'Trainings are unavailable right now.');
  return json(await listTrainingWorkflows(token));
};

// Delete one training. The token scopes to the caller, so this only touches the caller's own workflows.
export const DELETE: RequestHandler = async ({ locals, url }) => {
  const workflowId = url.searchParams.get('id');
  if (!workflowId) error(400, 'A workflow id is required.');
  const token = await requireToken(
    locals,
    'Delete is unavailable right now — no orchestrator token.'
  );

  try {
    await deleteTraining(token, workflowId);
  } catch (err) {
    if (err instanceof DeleteRefusedError) error(409, err.message);
    console.warn('[training-studio] deleteTraining failed', err);
    error(502, 'Could not delete this training.');
  }
  return json({ ok: true });
};
