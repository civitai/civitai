import { redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { modelQueueActions } from './actions.server';
import { loadModelItem } from './item.server';

// The bare queue opens its first model, as the user queue opens its first account. Rendered here
// rather than redirected to `/reports/model/<id>` — a redirect would run the queue twice on every
// filter change, once for this URL and again for the one it named.
export const load: PageServerLoad = async ({ url, parent }) => {
  // `?model=<id>` was the open model before it moved into the path. Kept so links already handed
  // round still open the model they named; every other param means the same there.
  const legacy = Number(url.searchParams.get('model'));
  if (Number.isInteger(legacy) && legacy > 0) {
    const params = new URLSearchParams(url.search);
    params.delete('model');
    redirect(308, `/reports/model/${legacy}${params.size ? `?${params}` : ''}`);
  }

  const { items } = await parent();
  const first = items.find((r) => r.entityId != null)?.entityId;
  return { item: first ? await loadModelItem(first) : null };
};

export const actions = modelQueueActions;
