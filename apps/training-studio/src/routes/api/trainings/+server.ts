import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireToken } from '$lib/server/token';
import { listTrainingWorkflows } from '$lib/server/orchestrator';

// The caller's training runs, for the "reuse a dataset" picker in the Data step.
export const GET: RequestHandler = async ({ locals }) => {
  if (locals.devPreview) return json([]);
  const token = await requireToken(locals, 'Trainings are unavailable right now.');
  return json(await listTrainingWorkflows(token));
};
