import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { pollAutoLabel, upstreamStatus } from '$lib/server/autolabel';

// Poll one auto-label workflow. It runs on the system token; the main app scopes it to the caller.
export const GET: RequestHandler = async ({ locals, params, request }) => {
  if (locals.devPreview) error(503, 'Auto-labeling needs a main-app session (not in dev preview).');

  try {
    return json(await pollAutoLabel(request.headers.get('cookie') ?? '', params.id));
  } catch (err) {
    console.warn('[training-studio] pollAutoLabel failed', err);
    error(upstreamStatus(err), 'Could not read auto-label progress.');
  }
};
