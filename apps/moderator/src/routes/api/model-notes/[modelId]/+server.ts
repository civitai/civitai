import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireIdParam } from '$lib/server/api-guard';
import { getModelNotes } from '$lib/server/model-notes.service';

// Notes come from the MODERATOR database — a second connection, so they are fetched client-side rather
// than made part of the model lookup's critical path.
export const GET: RequestHandler = async ({ params, locals }) => {
  const modelId = requireIdParam(locals, params.modelId, '/retool/model-lookup', 'modelId');
  const notes = await getModelNotes(modelId, locals.user.username ?? null);
  return json({ notes });
};
