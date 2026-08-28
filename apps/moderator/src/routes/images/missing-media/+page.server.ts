import { fail } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { getMissingMediaImages, isMissingMediaImage } from '$lib/server/ingestion.service';
import { deleteImagesByIds } from '$lib/server/image-deletion';
import { recordModActivity } from '$lib/server/mod-activity';

const LIMIT_OPTIONS = [10, 25, 50, 100];

/**
 * Images whose scan failed permanently because the media itself could not be fetched or decoded.
 * They are carved out of `/images/ingestion-errors` deliberately: rating one there set
 * `ingestion='Scanned'` and published a permanent 404. There is no rating affordance here, because
 * these can never be scanned — the only useful action is removing the row.
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
  delete: async ({ request, locals }) => {
    const form = await request.formData();
    const id = Number(form.get('id'));
    if (!id) return fail(400, { error: 'Missing image id' });

    /**
     * 🔴 SCOPE THE DELETE TO WHAT THIS PAGE SHOWS.
     *
     * `deleteImagesByIds` is permanent and cascading — row, stored object, search de-index — and
     * the id arrives on a form. Every other caller in the app hands it a server-computed id set;
     * without this re-selection through the SAME shared predicate the page is an arbitrary
     * delete-any-image-by-id endpoint that merely happens to render the missing-media queue.
     */
    if (!(await isMissingMediaImage(id)))
      return fail(400, { error: 'That image is not in the missing-media queue.' });

    try {
      await deleteImagesByIds([id]);
    } catch (e) {
      return fail(400, { error: e instanceof Error ? e.message : 'Failed to delete.' });
    }

    // Every other mutating moderator action is attributed; a permanent destructive one especially
    // should not land anonymously. After the delete, so a failed delete records nothing.
    await recordModActivity({
      userId: locals.user.id,
      entityType: 'image',
      entityId: id,
      activity: 'deleteMissingMedia',
    });

    return { success: true, id };
  },
};
