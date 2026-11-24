import { error, json } from '@sveltejs/kit';
import { sql } from '@civitai/db/kysely';
import type { RequestHandler } from './$types';
import { requireIdParam } from '$lib/server/api-guard';
import { dbRead } from '$lib/server/db';
import { holdsCsamReview } from '$lib/server/held-media';
import { restrictedImageIds } from '$lib/server/retracted-media';
import {
  getFlaggedRemixes,
  getImageEvents,
  getReactionSignals,
} from '$lib/server/image-signals.service';
import { section } from '$lib/server/section';

// The ClickHouse half of Image Lookup, off the page load: ~200-400ms each even bounded, against tables
// of 825M and 8.2M rows.
//
// `createdAt` is read here rather than passed by the client so a caller cannot widen the bound and turn
// these into full-table scans — and it is read with `to_char` rather than as a Date. `Image.createdAt` is
// `timestamp without time zone` with no pg parser registered, so node-pg would hand back a value shifted
// by the server's UTC offset; formatting in SQL keeps the conversion out of JS entirely.
export const GET: RequestHandler = async ({ params, locals }) => {
  const imageId = requireIdParam(locals, params.imageId, '/retool/image-lookup', 'imageId');
  // Its events and remixes say why an image was withheld, so they are withheld with it. An image the
  // primary lacks is withheld too, so a ToS-deleted image's events load only for csamReview.
  const withheld = await restrictedImageIds([imageId], {
    csamReview: holdsCsamReview(locals.user),
  });
  if (withheld.has(imageId)) error(403, 'Not available to you');

  const image = await dbRead
    .selectFrom('Image')
    .select(sql<string>`to_char("createdAt", 'YYYY-MM-DD HH24:MI:SS')`.as('createdAt'))
    .where('id', '=', imageId)
    .executeTakeFirst();

  // A ToS-deleted image has no Postgres row but still has a lifecycle log, and that log is the record of
  // the deletion — so the events still load for a csamReview holder. Reaction clustering does not: without `createdAt` there is
  // no lower bound, and an unbounded scan of the 825M-row reactions table is not worth it for an image
  // that no longer exists.
  const [events, reactions, flaggedRemixes] = await Promise.all([
    getImageEvents(imageId),
    image ? getReactionSignals(imageId, image.createdAt) : null,
    image
      ? section(`image-signals ${imageId}`, 'flagged remixes', () =>
          getFlaggedRemixes(imageId, image.createdAt)
        )
      : null,
  ]);

  return json({ events, reactions, flaggedRemixes });
};
