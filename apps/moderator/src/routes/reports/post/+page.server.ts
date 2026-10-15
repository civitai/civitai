import type { PageServerLoad } from './$types';
import { postQueueActions } from './actions.server';
import { loadPostItem } from './item.server';

// The bare queue opens its first post, as the user and model queues open their first item. Rendered
// here rather than redirected to `/reports/post/<id>` — a redirect would run the queue twice on every
// filter change, once for this URL and again for the one it named.
export const load: PageServerLoad = async ({ parent, locals }) => {
  const { items } = await parent();
  const first = items.find((r) => r.entityId != null)?.entityId;
  return { item: first ? await loadPostItem(first, 'images', locals) : null };
};

export const actions = postQueueActions;
