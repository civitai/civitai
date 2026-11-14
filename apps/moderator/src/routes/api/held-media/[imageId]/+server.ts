import { error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireIdParam } from '$lib/server/api-guard';
import { getHeldMedia, HELD_MEDIA_PAGE, recordHeldView } from '$lib/server/held-media';
import { streamStoredMedia } from '$lib/server/held-media-stream';
import { SHEET_COOKIE, sheetCookie } from '$lib/server/held-sheet';

/**
 * A CSAM-queue image or video, from storage rather than the public CDN, for the review grid and its
 * full-size view.
 *
 * The browser names an image id and nothing else: the key comes from this app's own read of the row,
 * and only for an image `heldImageSql` holds, so this is no general way past the CDN.
 */
export const GET: RequestHandler = async ({ params, locals, request, cookies }) => {
  const imageId = requireIdParam(locals, params.imageId, HELD_MEDIA_PAGE, 'image id');
  // Narrows the type; `requireIdParam` has already refused a request without a user.
  if (!locals.user) error(403, 'Not signed in.');
  const moderatorId = locals.user.id;
  const credential = locals.heldCredential === 'sheet' ? 'sheet' : 'web';

  const media = await getHeldMedia(imageId);
  if (!media) error(404, 'Not available here.');

  const sheetToken = credential === 'sheet' ? cookies.get(SHEET_COOKIE) : undefined;
  return streamStoredMedia({
    media,
    imageId,
    moderatorId,
    sheet: credential === 'sheet',
    request,
    audit: () => recordHeldView(moderatorId, imageId, credential),
    setCookie: sheetToken ? sheetCookie(sheetToken) : undefined,
  });
};
