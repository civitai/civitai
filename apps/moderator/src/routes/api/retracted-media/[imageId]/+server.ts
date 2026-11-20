import { error, isHttpError, json } from '@sveltejs/kit';
import { RETRACTED_MEDIA_MAX_BYTES } from '@civitai/shared/retracted-media';
import type { RequestHandler } from './$types';
import { canAccess } from '$lib/server/access';
import { HELD_MEDIA_PAGE, recordHeldView } from '$lib/server/held-media';
import { streamStoredMedia } from '$lib/server/held-media-stream';
import { retractedMediaRetryAfter } from '$lib/server/retracted-media-rate';
import {
  getModeratorMedia,
  recordRetractedView,
  retractedMediaEnabled,
} from '$lib/server/retracted-media';

const MAX_INT = 2_147_483_647;

/**
 * A blocked image or video for any moderator, from storage rather than the public CDN, for the
 * moderator pages that show images. The browser names an image id and nothing else: the key comes
 * from this app's own read of the row, and only for an image `getModeratorMedia` allows this
 * moderator. CSAM-restricted media needs the CSAM page's grant. A moderator with that grant is also
 * served held media here, audited as a held view, so image pages need not know which route holds it.
 */
const NO_STORE = { 'cache-control': 'private, no-store' };

/** Refusals carry no-store too, so no shared cache keeps one and refuses another moderator. */
export const GET: RequestHandler = async (event) => {
  try {
    return await serve(event);
  } catch (e) {
    if (!isHttpError(e)) throw e;
    return json(e.body, { status: e.status, headers: NO_STORE });
  }
};

const serve: RequestHandler = async ({ params, locals, request, url }) => {
  if (!retractedMediaEnabled()) error(404, 'Not found.');
  if (!locals.user) error(403, 'Not signed in.');
  const imageId = Number(params.imageId);
  if (!Number.isInteger(imageId) || imageId <= 0 || imageId > MAX_INT) error(400, 'Bad image id.');
  const moderatorId = locals.user.id;
  const retryAfter = await retractedMediaRetryAfter(moderatorId);
  if (retryAfter !== null)
    return json(
      { message: 'Too many requests.' },
      { status: 429, headers: { ...NO_STORE, 'retry-after': String(retryAfter) } }
    );
  const csamReview = canAccess(locals.user, HELD_MEDIA_PAGE);

  const media = await getModeratorMedia(imageId, { csamReview }).catch(() => {
    error(503, 'Could not check this image; retry.');
  });
  if (!media) error(404, 'Not available here.');
  // Eligibility alone, so a tile whose load failed can say why; nothing is served or audited.
  if (url.searchParams.get('probe') === '1')
    return new Response(null, { status: 204, headers: NO_STORE });

  if (media.kind === 'held')
    return streamStoredMedia({
      media,
      imageId,
      moderatorId,
      sheet: false,
      request,
      audit: () => recordHeldView(moderatorId, imageId, 'web'),
      // Held files are not size-capped, as on /api/held-media; every range is audited here.
      auditEveryRange: true,
    });
  return streamStoredMedia({
    media,
    imageId,
    moderatorId,
    sheet: false,
    request,
    audit: () => recordRetractedView(moderatorId, imageId),
    auditEveryRange: true,
    maxBytes: RETRACTED_MEDIA_MAX_BYTES,
  });
};
