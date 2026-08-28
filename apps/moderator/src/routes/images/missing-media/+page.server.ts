import { fail } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { getMissingMediaImages } from '$lib/server/ingestion.service';
import { deleteImagesByIds } from '$lib/server/image-deletion';

const LIMIT_OPTIONS = [10, 25, 50, 100];

/**
 * Images whose scan failed permanently because the media itself could not be fetched. They are
 * carved out of `/images/ingestion-errors` deliberately: rating one there set `ingestion='Scanned'`
 * and published a permanent 404. There is no rating affordance here, because there is nothing to
 * rate — the only useful action is removing the row.
 */
export const load: PageServerLoad = async ({ url }) => {
  const limitParam = Number(url.searchParams.get('limit'));
  const limit = LIMIT_OPTIONS.includes(limitParam) ? limitParam : 50;
  const cursor = Number(url.searchParams.get('cursor')) || undefined;

  const data = await getMissingMediaImages({ limit, cursor });
  return { limit, limitOptions: LIMIT_OPTIONS, wide: true, ...data };
};

// Access is enforced globally (hooks.server.ts).
export const actions: Actions = {
  delete: async ({ request }) => {
    const form = await request.formData();
    const id = Number(form.get('id'));
    if (!id) return fail(400, { error: 'Missing image id' });

    try {
      await deleteImagesByIds([id]);
    } catch (e) {
      return fail(400, { error: e instanceof Error ? e.message : 'Failed to delete.' });
    }
    return { success: true, id };
  },
};
