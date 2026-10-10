import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireToken } from '$lib/server/token';
import { createEpochArchive } from '$lib/server/orchestrator';
import {
  ArchiveRejectedError,
  NothingToArchiveError,
  RunNotFoundError,
} from '$lib/orchestrator-core';

// POST — it creates an archive step on the orchestrator, so it must not be a prefetchable GET.
export const POST: RequestHandler = async ({ locals, url }) => {
  const id = url.searchParams.get('id');
  if (!id) error(400, 'Missing run id.');
  const token = await requireToken(locals, 'Archive downloads are unavailable right now.');
  try {
    return json(await createEpochArchive(token, id));
  } catch (err) {
    if (err instanceof RunNotFoundError) error(404, 'Training not found.');
    if (err instanceof NothingToArchiveError)
      error(409, 'No checkpoint weights are ready to download yet.');
    if (err instanceof ArchiveRejectedError)
      error(400, "The orchestrator couldn't archive this run.");
    console.warn('[training-studio] epoch archive failed', err);
    error(502, "Couldn't build the archive — try again in a moment.");
  }
};
