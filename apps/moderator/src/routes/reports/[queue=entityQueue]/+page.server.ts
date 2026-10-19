import type { PageServerLoad } from './$types';
import { loadEntityItem } from '$lib/server/entity-queue-load';
import { entityQueueActions } from './actions.server';

// The bare queue opens its first item, as the user, model and post queues do. Rendered here rather
// than redirected to `<queue>/<id>` — a redirect would run the queue twice on every filter change, once
// for this URL and again for the one it named.
export const load: PageServerLoad = async ({ parent, locals, url }) => {
  const { items, queueType } = await parent();
  const first = items.find((r) => r.entityId != null)?.entityId;
  return { item: first ? await loadEntityItem(queueType, first, locals, url) : null };
};

export const actions = entityQueueActions;
