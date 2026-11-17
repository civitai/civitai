import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireToken } from '$lib/server/token';
import { getRunDataset } from '$lib/server/orchestrator';
import { askerOf, assertNotWithheld, RunWithheldError } from '$lib/server/withheld';

// A run's dataset (blob airs + captions) for Remix / "reuse a dataset". The token scopes to the caller.
export const GET: RequestHandler = async ({ locals, request, url }) => {
  const id = url.searchParams.get('id');
  if (!id) error(400, 'Missing run id.');
  const token = await requireToken(locals, 'Dataset is unavailable right now.');
  try {
    await assertNotWithheld(askerOf({ locals, request }), id);
  } catch (err) {
    if (err instanceof RunWithheldError) error(403, err.message);
    throw err;
  }
  return json(await getRunDataset(token, id));
};
