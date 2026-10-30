import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireToken } from '$lib/server/token';
import { pollAutoLabel } from '$lib/server/autolabel';

// Poll one auto-label workflow. The token scopes to the caller, so the orchestrator only returns the
// caller's own workflows.
export const GET: RequestHandler = async ({ locals, params }) => {
  const token = await requireToken(
    locals,
    'Auto-labeling is unavailable right now — no orchestrator token.'
  );

  try {
    return json(await pollAutoLabel(token, params.id));
  } catch (err) {
    console.warn('[training-studio] pollAutoLabel failed', err);
    error(502, 'Could not read auto-label progress.');
  }
};
