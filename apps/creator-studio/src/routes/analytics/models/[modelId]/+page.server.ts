import { error } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { getModelVersionAnalytics } from '$lib/server/models-earnings';
import { parseRange } from '$lib/date-range';

export const load: PageServerLoad = async ({ locals, params, url }) => {
  const modelId = Number(params.modelId);
  if (!Number.isInteger(modelId) || modelId <= 0) throw error(400, 'Invalid model id');
  const range = parseRange(url.searchParams.get('from'), url.searchParams.get('to'), 30);
  // Ownership is enforced inside the read (returns null for a model that isn't the caller's).
  const model = await getModelVersionAnalytics({ userId: locals.user.id, modelId, ...range });
  if (!model) throw error(404, 'Model not found, or not yours');
  return { model };
};
