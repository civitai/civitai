import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireToken } from '$lib/server/token';
import { getRunDataset } from '$lib/server/orchestrator';

// A run's dataset (blob airs + captions) for Remix / "reuse a dataset". The token scopes to the caller.
export const GET: RequestHandler = async ({ locals, url }) => {
  const id = url.searchParams.get('id');
  if (!id) error(400, 'Missing run id.');
  const token = await requireToken(locals, 'Dataset is unavailable right now.');
  return json(await getRunDataset(token, id));
};
