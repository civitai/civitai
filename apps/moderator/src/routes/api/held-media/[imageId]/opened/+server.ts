import { error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { shownActivity } from '@civitai/shared/held-media';
import { requireIdParam } from '$lib/server/api-guard';
import { getHeldMedia, HELD_MEDIA_PAGE } from '$lib/server/held-media';
import { recordModActivity } from '$lib/server/mod-activity';

// Sent by the full view once the image is on screen. The row is the session moderator's, stamped by
// the database; the page names only the image.
export const POST: RequestHandler = async ({ params, locals, request }) => {
  const imageId = requireIdParam(locals, params.imageId, HELD_MEDIA_PAGE, 'image id');
  if (!locals.user) error(403, 'Not signed in.');
  if ((await request.text()) !== '') error(400, 'This request takes no body.');
  if (!(await getHeldMedia(imageId))) error(404, 'Not available here.');

  await recordModActivity({
    userId: locals.user.id,
    entityType: 'image',
    entityId: imageId,
    activity: shownActivity('open', 'original'),
  });
  return new Response(null, { status: 204 });
};
