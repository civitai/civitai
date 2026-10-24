import { error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { isProbeableMediaKey } from '@civitai/shared/media-key';
import {
  forwardableRange,
  heldMediaContentType,
  heldMediaHeaders,
  isFullViewOpen,
} from '@civitai/shared/held-media';
import { requireIdParam } from '$lib/server/api-guard';
import { getHeldMedia, HELD_MEDIA_PAGE, recordHeldFullView } from '$lib/server/held-media';
import { getStorage } from '$lib/server/storage';

/**
 * A CSAM-queue image or video, from storage rather than the public CDN, for the review grid
 * (`?view=full` for the full-size view, which is audited per open).
 *
 * The browser names an image id and nothing else: the key comes from this app's own read of the row,
 * and only for an image in the review queue or of a held owner, so this is no general way past the CDN.
 */
export const GET: RequestHandler = async ({ params, locals, request, url }) => {
  const imageId = requireIdParam(locals, params.imageId, HELD_MEDIA_PAGE, 'image id');
  if (!locals.user) error(403, 'Not signed in.');

  const media = await getHeldMedia(imageId);
  if (!media || !isProbeableMediaKey(media.url)) error(404, 'Not available here.');

  const signed = await getStorage()
    .getGetUrl({ backend: 'b2Image', key: media.url, expiresIn: 60 })
    .catch((e) => {
      console.error('[held-media] presign failed', e);
      return null;
    });
  if (!signed) error(502, 'Could not reach storage.');

  const range = forwardableRange(request.headers.get('range'));
  const upstream = await fetch(signed.url, {
    headers: range ? { range } : {},
    signal: request.signal,
  }).catch((e) => {
    console.error('[held-media] fetch failed', e);
    return null;
  });
  if (!upstream) error(502, 'Could not reach storage.');
  if (upstream.status === 404) error(404, 'The file is not in storage.');
  if (upstream.status === 416)
    return new Response(null, {
      status: 416,
      headers: heldMediaHeaders('application/octet-stream', upstream.headers),
    });
  if ((upstream.status !== 200 && upstream.status !== 206) || !upstream.body) {
    console.error('[held-media] upstream refused', upstream.status);
    void upstream.body?.cancel();
    error(502, `Storage would not serve this file (${upstream.status}).`);
  }

  const contentType = heldMediaContentType(media.type, [
    upstream.headers.get('content-type'),
    media.mimeType,
  ]);
  if (!contentType) {
    void upstream.body.cancel();
    error(415, 'This video type does not play in a browser.');
  }

  if (isFullViewOpen(url.searchParams.get('view'), range))
    recordHeldFullView(locals.user.id, imageId);

  return new Response(upstream.body, {
    status: upstream.status,
    headers: heldMediaHeaders(contentType, upstream.headers),
  });
};
