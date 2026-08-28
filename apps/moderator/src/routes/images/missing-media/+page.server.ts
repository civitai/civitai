import { fail } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import {
  getMissingMediaImages,
  imageRowExists,
  isMissingMediaImage,
} from '$lib/server/ingestion.service';
import { deleteImagesByIds } from '$lib/server/image-deletion';
import { recordModActivity } from '$lib/server/mod-activity';

const LIMIT_OPTIONS = [10, 25, 50, 100];

/**
 * Images that can never be published: the media itself could not be fetched or decoded (a permanent
 * scan failure), or the url is a browser-session `blob:` handle that can never render for anyone.
 * They are carved out of `/images/ingestion-errors` deliberately: rating one there set
 * `ingestion='Scanned'` and published a permanent 404. There is no rating affordance here, because
 * these can never be scanned — the only useful action is removing the row.
 *
 * 🔴 This page is the reachable action behind the `unrenderable` refusal `assertMediaPresentForPublish`
 * throws, and behind those `absent` refusals whose row also carries a permanent scan class. The
 * rating queue 400s on these rows, so if `missingMediaWhere` ever stopped selecting one of them the
 * moderator would have no action left at all — which is why the queue predicate and the delete gate
 * are built from one const.
 *
 * 🔴 It is NOT the reachable action behind EVERY refusal, and the exceptions are named rather than
 * implied. `absent` is a probe verdict and cannot be selected on in SQL, so a row with a transient
 * or unclassified failure whose object is genuinely gone is refused on the rating queue and not
 * listed here; and both queues carry a 2-day window this page inherits, so an older row is deletable
 * by this action but rendered by no page. Both gaps, why widening the predicate is the wrong fix for
 * the first, and the query that would settle the second, are written out on `unpublishableMedia` and
 * `ingestionErrorBaseWhere` in `$lib/server/ingestion.service`.
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

    // Kept as insurance if the collaborator ever starts throwing, but it is UNREACHABLE today —
    // `deleteImagesByIds` catches per image and its one un-caught statement is a `void`-ed async
    // call. Deliberately untested: there is no reachable input that enters this branch, and a test
    // that forced one would be pinning a state the real function cannot produce.
    try {
      await deleteImagesByIds([id]);
    } catch (e) {
      return fail(400, { error: e instanceof Error ? e.message : 'Failed to delete.' });
    }

    /**
     * 🔴 A RESOLVED `deleteImagesByIds` IS NOT EVIDENCE THE IMAGE IS GONE.
     *
     * It wraps every per-image body in a `try/catch` that logs and continues, and its only statement
     * outside a try is a `void`-ed async call — so it effectively never rejects. A failed DB step
     * returns normally, which previously produced `{ success: true }`, a card rendering "Deleted",
     * and a `deleteMissingMedia` audit row attesting a delete that never happened, all for an image
     * still on the site.
     *
     * So confirm by reading the row back. Cheap, and it is the difference between an audit log that
     * records outcomes and one that records intentions.
     *
     * Scope, precisely: this confirms the ROW is gone, which is the authoritative moderation
     * outcome. It does NOT confirm the stored object was removed — that delete is best-effort and
     * swallowed inside `deleteImagesByIds` — so a success here can still leave an orphaned object.
     */
    if (await imageRowExists(id))
      return fail(400, {
        error: 'The delete did not complete — the image is still present. Nothing was recorded.',
      });

    // Attributed only once the delete is CONFIRMED. Every other mutating moderator action is
    // attributed; a permanent destructive one especially should not land anonymously.
    await recordModActivity({
      userId: locals.user.id,
      entityType: 'image',
      entityId: id,
      activity: 'deleteMissingMedia',
    });

    return { success: true, id };
  },
};
