import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireToken } from '$lib/server/token';
import { listGenerations, orchestratorClient } from '$lib/server/orchestrator';
import { listEditGenerations } from '$lib/edit-helpers-core';
import { isMedia } from '$lib/data/trainingModels';

// Token stays server-side; the client gets only blob ids + presigned preview URLs.
export const GET: RequestHandler = async ({ locals, url }) => {
  const media = url.searchParams.get('media');
  if (!isMedia(media)) error(400, 'Unknown media type.');

  const token = await requireToken(
    locals,
    'Your generations are unavailable right now — no orchestrator token.'
  );

  try {
    if (url.searchParams.get('kind') === 'edit')
      return json({ items: await listEditGenerations(orchestratorClient(token)) });
    return json({ items: await listGenerations(token, media) });
  } catch (err) {
    console.warn('[training-studio] listGenerations failed', err);
    error(502, 'Could not load your generations. Try again.');
  }
};
