import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireToken } from '$lib/server/token';
import { getTrainingWorkflow } from '$lib/server/orchestrator';

// One run's detail through the seam — the /[id] page still loads via its server load; this serves
// RunDetail's ancestor-chain reads (combined epochs). The token scopes to the caller.
export const GET: RequestHandler = async ({ locals, url }) => {
  const id = url.searchParams.get('id');
  if (!id) error(400, 'Missing run id.');
  const token = await requireToken(locals, 'Training detail is unavailable right now.');
  const detail = await getTrainingWorkflow(token, id);
  if (!detail) error(404, 'Training not found.');
  return json(detail);
};
