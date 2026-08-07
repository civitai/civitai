import { z } from 'zod';
import type { PageServerLoad } from './$types';
import { parseQuery } from '$lib/server/query';
import { getImageLookup, resolveImageId } from '$lib/server/image-lookup.service';
import { hasImageEvents } from '$lib/server/image-signals.service';

const querySchema = z.object({ q: z.string().trim().catch('') });

// Read-only. Every action Retool's Image Lookup could take lived in other apps (Bulk Image Manager,
// User Reports); this one only ever answered questions, so there is nothing to gate beyond the page.
export const load: PageServerLoad = async ({ url }) => {
  const { q } = parseQuery(url, querySchema);
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
  const deletedImageId = !result && imageId && (await hasImageEvents(imageId)) ? imageId : null;

  return { q, result, deletedImageId, notFound: !result && !deletedImageId };
};
