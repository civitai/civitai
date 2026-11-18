import { error, isHttpError, json } from '@sveltejs/kit';
import { RETRACTED_MEDIA_MAX_BYTES } from '@civitai/shared/retracted-media';
import type { RequestHandler } from './$types';
import { canAccess } from '$lib/server/access';
import {
  COVERED_REFUSED,
  coveredViewEnabled,
  getCoveredRetractedMedia,
} from '$lib/server/csam-view';
import { HELD_MEDIA_PAGE } from '$lib/server/held-media';
import { streamStoredMedia } from '$lib/server/held-media-stream';
import {
  getRetractedMedia,
  NEEDS_CSAM_QUEUE,
  recordRetractedView,
  retractedMediaEnabled,
} from '$lib/server/retracted-media';

const MAX_INT = 2_147_483_647;

/**
 * A blocked image or video for any moderator, from storage rather than the public CDN, for the
 * moderator pages that show images. The browser names an image id and nothing else: the key comes
 * from this app's own read of the row, and only for an image `getRetractedMedia` allows this
 * moderator. One with a CSAM or minor signal needs the CSAM page's grant; held media is
 * `/api/held-media`'s.
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
  const csamReview = canAccess(locals.user, HELD_MEDIA_PAGE);

  // Without the CSAM page's grant, the covered view first: anything blocked but reported bytes. Only
  // for a GET of the bytes, which writes its row: a probe or HEAD gets the answer it gets without it,
  // so neither tells a reported image from an unreported one unrecorded.
  const covered =
    !csamReview &&
    coveredViewEnabled() &&
    request.method === 'GET' &&
    url.searchParams.get('probe') !== '1'
      ? await getCoveredRetractedMedia(imageId, moderatorId)
      : null;
  if (covered === COVERED_REFUSED) error(404, 'Not available here.');
  const media = covered ?? (await getRetractedMedia(imageId, { csamReview }));
  if (media === NEEDS_CSAM_QUEUE) error(403, 'Needs CSAM-queue access.');
  if (!media) error(404, 'Not available here.');
  // Eligibility alone, so a tile whose load failed can say why; nothing is served or audited.
  if (url.searchParams.get('probe') === '1')
    return new Response(null, { status: 204, headers: NO_STORE });

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
