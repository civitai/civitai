import { error } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { loadEntityItem } from '$lib/server/entity-queue-load';
import { MAX_INT4 } from '$lib/server/users.service';
import { entityQueueForSlug } from '$lib/entity-report-queues';
import { entityQueueActions } from '../actions.server';

// The queue opened on one item, in the path so a link opens the same view for whoever follows it.
export const load: PageServerLoad = async ({ params, locals, url }) => {
  const type = entityQueueForSlug(params.queue);
  if (!type) error(404, 'Unknown report type');
  const id = Number(params.id);
  if (!Number.isInteger(id) || id <= 0 || id > MAX_INT4) error(404, 'Not an id');
  return { item: await loadEntityItem(type, id, locals, url) };
};

export const actions = entityQueueActions;
