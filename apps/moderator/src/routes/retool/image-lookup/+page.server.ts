import type { PageServerLoad } from './$types';
import { lookupQuerySchema, parseQuery } from '$lib/server/query';
import { getImageLookup, resolveImageId } from '$lib/server/image-lookup.service';
import { hasImageEvents } from '$lib/server/image-signals.service';

// Read-only — but NOT because Retool's was. A screenshot of the live app shows `Toggle Minor ON` and
// `Toggle Poi ON` beside the image data, so it could write; the export carries no mutation query and is
// stale against that screen. Porting those two actions is an open parity item, not a settled decision.
export const load: PageServerLoad = async ({ url }) => {
  const { q } = parseQuery(url, lookupQuerySchema);
  if (!q) return { q, result: null, deletedImageId: null, notFound: false };

  const imageId = await resolveImageId(q);
  const result = imageId ? await getImageLookup(imageId) : null;

  // A ToS deletion removes the Image row but leaves the ClickHouse lifecycle log — which is the record of
  // WHY it was removed, and the thing a moderator is looking for when an id no longer resolves.
  //
  // Gated on the log ACTUALLY having events. An id is just digits: a moderator transposing one from a
  // report would otherwise be told "Image #… no longer exists — which is what a ToS removal does", and
  // could reasonably close the report believing the content was found and actioned. An id with no row and
  // no events never existed.
  // Guarded: this is the only ClickHouse call in `load`, and it runs on the MISS path — so without the
  // catch, ClickHouse being down turns "no image matches" into an error page.
  let deletedImageId: number | null = null;
  if (!result && imageId) {
    try {
      if (await hasImageEvents(imageId)) deletedImageId = imageId;
    } catch (e) {
      console.error('[image-lookup] deleted-image check unavailable', e);
    }
  }

  return { q, result, deletedImageId, notFound: !result && !deletedImageId };
};
