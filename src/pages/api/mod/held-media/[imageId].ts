import type { NextApiRequest, NextApiResponse } from 'next';
import { Readable } from 'stream';
import { pipeline } from 'stream/promises';
import type { ReadableStream as NodeReadableStream } from 'stream/web';
import * as z from 'zod';
import { isProbeableMediaKey } from '@civitai/shared/media-key';
import {
  fetchHeldObject,
  forwardableRange,
  heldMediaContentType,
  heldMediaHeaders,
  heldServeRecord,
  isAuditedServe,
  NOT_HELD,
  NOT_HELD_HEADER,
  SERVED_ACTIVITY,
} from '@civitai/shared/held-media';
import { logToAxiom } from '~/server/logging/client';
import { getFeatureFlags } from '~/server/services/feature-flags.service';
import { getHeldMedia } from '~/server/services/held-media.service';
import { trackModActivity } from '~/server/services/moderator.service';
import { ModEndpoint } from '~/server/utils/endpoint-helpers';
import type { SessionUser } from '~/types/session';
import { getGetUrlByKey, getImageUploadBackend } from '~/utils/s3-utils';

export const config = { api: { responseLimit: false } };

const query = z.object({ imageId: z.coerce.number().int().positive().max(2_147_483_647) });

/**
 * A held image or video for the CSAM report page, from storage rather than the public CDN. The
 * browser names an image id and nothing else; the key comes from the row, and only for an image
 * `heldImageSql` holds. The moderator app's `/api/held-media` is the same route for its grid.
 *
 * `?probe=1` answers eligibility alone (204, or the not-held 404) and serves nothing, so the page can
 * tell "not held, use the CDN" from any other failure without fetching the file again.
 */
async function handler(req: NextApiRequest, res: NextApiResponse, user: SessionUser) {
  res.setHeader('cache-control', 'private, no-store');
  if (!getFeatureFlags({ user, req }).csamReports)
    return void res.status(403).json({ error: 'Forbidden' });

  const parsed = query.safeParse(req.query);
  if (!parsed.success) return void res.status(400).json({ error: 'Bad image id' });
  const { imageId } = parsed.data;

  const media = await getHeldMedia(imageId);
  if (!media) {
    res.setHeader(NOT_HELD_HEADER, NOT_HELD);
    return void res.status(404).json({ error: 'Not available here' });
  }
  // Held, but not a key this store can serve: no not-held answer, so the page never shows the CDN copy.
  if (!isProbeableMediaKey(media.url))
    return void res.status(422).json({ error: 'This file is not in a servable place' });
  if (req.query.probe === '1') return void res.status(204).end();

  let signedUrl: string;
  try {
    const { s3, bucket } = await getImageUploadBackend();
    ({ url: signedUrl } = await getGetUrlByKey(media.url, { s3, bucket, expiresIn: 60 }));
  } catch (e) {
    console.error('[held-media] presign failed', e);
    return void res.status(502).json({ error: 'Could not reach storage' });
  }

  const range = forwardableRange(req.headers.range);
  // The response's close, not the request's: the body parser has consumed the request already.
  const abort = new AbortController();
  res.on('close', () => abort.abort());
  const upstream = await fetchHeldObject(signedUrl, range, abort.signal).catch((e) => {
    if (!abort.signal.aborted) console.error('[held-media] fetch failed', e);
    return null;
  });
  if (!upstream) return void res.status(502).json({ error: 'Could not reach storage' });
  if (upstream.status === 404 || upstream.status === 416) void upstream.body?.cancel();
  if (upstream.status === 404)
    return void res.status(404).json({ error: 'The file is not in storage' });
  if (upstream.status === 416) {
    res.writeHead(416, heldMediaHeaders('application/octet-stream', upstream.headers, false));
    return void res.end();
  }
  if ((upstream.status !== 200 && upstream.status !== 206) || !upstream.body) {
    console.error('[held-media] upstream refused', upstream.status);
    void upstream.body?.cancel();
    return void res
      .status(502)
      .json({ error: `Storage would not serve this file (${upstream.status})` });
  }

  const contentType = heldMediaContentType(media.type, [
    upstream.headers.get('content-type'),
    media.mimeType,
  ]);
  if (!contentType) {
    void upstream.body.cancel();
    return void res.status(415).json({ error: 'This video type does not play in a browser' });
  }

  logToAxiom(
    heldServeRecord({
      moderatorId: user.id,
      imageId,
      status: upstream.status,
      range,
      upstream: upstream.headers,
    })
  ).catch(() => null);
  // Awaited, so the row is there before the page that loads these bytes reports them shown.
  if (isAuditedServe(upstream))
    await trackModActivity(user.id, {
      entityType: 'image',
      entityId: imageId,
      activity: SERVED_ACTIVITY,
    }).catch((e) => console.error('[held-media] audit row failed', e));

  res.writeHead(upstream.status, heldMediaHeaders(contentType, upstream.headers));
  await pipeline(Readable.fromWeb(upstream.body as NodeReadableStream), res).catch((e) => {
    if (!abort.signal.aborted) console.error('[held-media] stream failed', e);
  });
}

export default ModEndpoint(handler);
