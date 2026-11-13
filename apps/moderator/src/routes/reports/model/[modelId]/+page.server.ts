import { error } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { MAX_INT4 } from '$lib/server/users.service';
import { modelQueueActions } from '../actions.server';
import { loadModelItem } from '../item.server';

// The queue opened on one model, in the path so a link opens the same model for whoever follows it.
export const load: PageServerLoad = async ({ params }) => {
  const modelId = Number(params.modelId);
  if (!Number.isInteger(modelId) || modelId <= 0 || modelId > MAX_INT4)
    error(404, 'Not a model id');
  return { item: await loadModelItem(modelId) };
};

export const actions = modelQueueActions;
