import { error } from '@sveltejs/kit';
import { isProbeableMediaKey } from '@civitai/shared/media-key';
import {
  fetchHeldObject,
  forwardableRange,
  heldMediaContentType,
  heldMediaHeaders,
  heldServeRecord,
  isAuditedServe,
} from '@civitai/shared/held-media';
import { recordHeldServe } from './held-media';
import { SHEET_IMAGE_TYPES } from './held-sheet';
import { getStorage } from './storage';

/**
 * Streams one stored image or video from storage rather than the public CDN. Every response carrying
 * bytes is logged, and `audit` runs, and must succeed, before any response from byte 0 is sent.
 * The caller has already decided this moderator may see this image.
 */
export async function streamStoredMedia(input: {
  media: { url: string; type: string; mimeType: string | null };
  imageId: number;
  moderatorId: number;
  sheet: boolean;
  request: Request;
  audit: () => Promise<unknown>;
  setCookie?: string;
}): Promise<Response> {
  const { media, imageId, request } = input;
  if (!isProbeableMediaKey(media.url)) error(404, 'Not available here.');

  const signed = await getStorage()
    .getGetUrl({ backend: 'b2Image', key: media.url, expiresIn: 60 })
    .catch((e) => {
      console.error('[held-media] presign failed', e);
      return null;
    });
  if (!signed) error(502, 'Could not reach storage.');

  // The sheet always gets the whole image, so every fetch it makes is audited.
  const range = input.sheet ? null : forwardableRange(request.headers.get('range'));
  const upstream = await fetchHeldObject(signed.url, range, request.signal).catch((e) => {
    console.error('[held-media] fetch failed', e);
    return null;
  });
  if (!upstream) error(502, 'Could not reach storage.');
  if (upstream.status === 404 || upstream.status === 416) void upstream.body?.cancel();
  if (upstream.status === 404) error(404, 'The file is not in storage.');
  if (upstream.status === 416)
    return new Response(null, {
      status: 416,
      headers: heldMediaHeaders('application/octet-stream', upstream.headers, false),
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
  if (input.sheet && !SHEET_IMAGE_TYPES.has(contentType.split(';')[0].trim())) {
    void upstream.body.cancel();
    error(415, 'Not an image type served here.');
  }

  recordHeldServe(
    heldServeRecord({
      moderatorId: input.moderatorId,
      imageId,
      status: upstream.status,
      range,
      upstream: upstream.headers,
    })
  );
  // Awaited, so the row is there before the page that loads these bytes reports them shown.
  if (request.method !== 'HEAD' && isAuditedServe(upstream)) {
    const written = await input.audit().then(
      () => true,
      (e) => {
        console.error('[held-media] view row not written', e);
        return false;
      }
    );
    if (!written) {
      void upstream.body.cancel();
      error(503, 'Could not record this view.');
    }
  }

  const headers = heldMediaHeaders(contentType, upstream.headers);
  if (input.setCookie) headers['set-cookie'] = input.setCookie;
  return new Response(upstream.body, { status: upstream.status, headers });
}
