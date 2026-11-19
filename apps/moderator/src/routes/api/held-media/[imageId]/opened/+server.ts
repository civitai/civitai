import { error } from '@sveltejs/kit';
import { sql } from '@civitai/db/kysely';
import type { RequestHandler } from './$types';
import { SERVED_ACTIVITY, shownActivity } from '@civitai/shared/held-media';
import { canAccess } from '$lib/server/access';
import { parseIdParam, requireIdParam } from '$lib/server/api-guard';
import { COVERED_REFUSED, coveredViewEnabled, getCoveredHeldMedia } from '$lib/server/csam-view';
import { dbWrite } from '$lib/server/db';
import { getHeldMedia, HELD_MEDIA_PAGE, type HeldMedia } from '$lib/server/held-media';

// Sent by the full view once the image is on screen. The row is the session moderator's, stamped by
// the database; the page names only the image.
export const POST: RequestHandler = async ({ params, locals, request, url }) => {
  // The covered view's moderators too, for the images it would serve them.
  const covered =
    !!locals.user &&
    locals.heldCredential !== 'sheet' &&
    !canAccess(locals.user, HELD_MEDIA_PAGE) &&
    coveredViewEnabled();
  const imageId = covered
    ? parseIdParam(params.imageId, 'image id')
    : requireIdParam(locals, params.imageId, HELD_MEDIA_PAGE, 'image id');
  if (!locals.user) error(403, 'Not signed in.');
  // A body-less POST skips SvelteKit's form-only origin check.
  if (request.headers.get('origin') !== url.origin) error(403, `Send from ${url.origin}.`);
  if ((await request.text()) !== '') error(400, 'This request takes no body.');
  let media: HeldMedia | null;
  if (covered) {
    const read = await getCoveredHeldMedia(imageId, locals.user.id);
    media = read === COVERED_REFUSED ? null : read;
  } else media = await getHeldMedia(imageId);
  if (!media) error(404, 'Not available here.');

  // Only as bytes this moderator was just served, in one statement with the serve read: within 30
  // minutes, or 3 hours for a video (its type from the image row), which plays for longer. Throws on
  // a failed write, unlike recordModActivity: the page should see a row that did not land.
  const userId = locals.user.id;
  const { rows } = await sql`
    INSERT INTO "ModActivity" ("userId", "entityType", activity, "entityId")
    SELECT ${userId}::int, 'image', ${shownActivity('open', 'original')}::text, ${imageId}::int
    WHERE EXISTS (
      SELECT 1 FROM "ModActivity"
      WHERE activity = ${SERVED_ACTIVITY}::text AND "entityType" = 'image'
        AND "entityId" = ${imageId}::int AND "userId" = ${userId}::int
        AND "createdAt" >= (now() AT TIME ZONE 'UTC') - CASE WHEN ${media.type === 'video'}::boolean
          THEN interval '3 hours' ELSE interval '30 minutes' END
    )
    ON CONFLICT DO NOTHING
    RETURNING id
  `.execute(dbWrite);
  // On the covered view, the same 404 as a refusal, so this cannot tell reported from not.
  if (!rows.length)
    error(covered ? 404 : 403, covered ? 'Not available here.' : 'Not served to you.');
  return new Response(null, { status: 204 });
};
