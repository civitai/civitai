import type { NextApiRequest, NextApiResponse } from 'next';
import { Readable } from 'stream';
import { pipeline } from 'stream/promises';
import type { ReadableStream as NodeReadableStream } from 'stream/web';
import * as z from 'zod';
import { prefixCacheKey } from '@civitai/redis';
import { isProbeableMediaKey } from '@civitai/shared/media-key';
import {
  fetchHeldObject,
  forwardableRange,
  heldMediaContentType,
  heldMediaHeaders,
} from '@civitai/shared/held-media';
import {
  RETRACTED_MEDIA_MAX_BYTES,
  RETRACTED_MEDIA_RATE_LIMIT,
  RETRACTED_MEDIA_STREAM_MS,
  RETRACTED_SERVED_ACTIVITY,
} from '@civitai/shared/retracted-media';
import { getFeatureFlagsAsync } from '~/server/services/feature-flags.service';
import { trackModActivity } from '~/server/services/moderator.service';
import { getRetractedMedia } from '~/server/services/retracted-media.service';
import { ModEndpoint } from '~/server/utils/endpoint-helpers';
import { checkFixedWindow } from '~/server/utils/public-api-rate-limit';
import type { SessionUser } from '~/types/session';
import { getGetUrlByKey, getImageUploadBackend } from '~/utils/s3-utils';

export const config = { api: { responseLimit: false } };

const query = z.object({ imageId: z.coerce.number().int().positive().max(2_147_483_647) });

/**
 * A blocked image or video for a moderator, from storage rather than the public CDN, which stops
 * serving a blocked image's url. The browser names an image id and nothing else: the key comes from
 * the row, and only for an image `getRetractedMedia` allows this moderator. The bytes come through
 * this server; the storage URL never leaves it.
 */
async function handler(req: NextApiRequest, res: NextApiResponse, user: SessionUser) {
  const flags = await getFeatureFlagsAsync({ user, req });
  if (!flags.modRetractedMedia) return void res.status(403).json({ error: 'Forbidden' });

  const parsed = query.safeParse(req.query);
  if (!parsed.success) return void res.status(400).json({ error: 'Bad image id' });
  const { imageId } = parsed.data;

  const limit = await checkFixedWindow(
    prefixCacheKey(`retracted-media:rate-limit:${user.id}`),
    RETRACTED_MEDIA_RATE_LIMIT,
    60,
    { failOpen: false }
  );
  if (!limit.allowed) {
    res.setHeader('retry-after', String(limit.retryAfterSeconds));
    return void res.status(429).json({ error: 'Too many requests' });
  }

  const media = await getRetractedMedia(imageId, { csamReview: !!flags.csamReports });
  if (!media) return void res.status(404).json({ error: 'Not available here' });
  if (!isProbeableMediaKey(media.url))
    return void res.status(422).json({ error: 'This file is not in a servable place' });

  let signedUrl: string;
  try {
    const { s3, bucket } = await getImageUploadBackend();
    ({ url: signedUrl } = await getGetUrlByKey(media.url, { s3, bucket, expiresIn: 60 }));
  } catch (e) {
    console.error('[retracted-media] presign failed', e);
    return void res.status(502).json({ error: 'Could not reach storage' });
  }

  const range = forwardableRange(req.headers.range);
  const abort = new AbortController();
  res.on('close', () => abort.abort());
  const upstream = await fetchHeldObject(signedUrl, range, abort.signal).catch((e) => {
    if (!abort.signal.aborted) console.error('[retracted-media] fetch failed', e);
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
    console.error('[retracted-media] upstream refused', upstream.status);
    void upstream.body?.cancel();
    return void res
      .status(502)
      .json({ error: `Storage would not serve this file (${upstream.status})` });
  }
  // Capped by the whole object, so a large one cannot be pulled in ranges, and an unknown or encoded
  // size counts as too large: the cap must hold before the first byte leaves.
  const length = Number(upstream.headers.get('content-length') ?? NaN);
  const total =
    upstream.status === 206
      ? Number(upstream.headers.get('content-range')?.match(/\/(\d+)$/)?.[1] ?? NaN)
      : length;
  if (
    upstream.headers.get('content-encoding') ||
    !Number.isFinite(length) ||
    !Number.isFinite(total) ||
    total > RETRACTED_MEDIA_MAX_BYTES
  ) {
    void upstream.body.cancel();
    return void res.status(413).json({ error: 'This file is too large to serve here' });
  }

  const contentType = heldMediaContentType(media.type, [
    upstream.headers.get('content-type'),
    media.mimeType,
  ]);
  if (!contentType) {
    void upstream.body.cancel();
    return void res.status(415).json({ error: 'This video type does not play in a browser' });
  }

  // Every response that carries bytes, ranges included, gets its row, awaited: unlike held-media,
  // a range is not assumed to belong to a view already recorded.
  const written = await trackModActivity(user.id, {
    entityType: 'image',
    entityId: imageId,
    activity: RETRACTED_SERVED_ACTIVITY,
  }).then(
    () => true,
    (e) => {
      console.error('[retracted-media] audit row failed', e);
      return false;
    }
  );
  if (!written) {
    void upstream.body.cancel();
    return void res.status(503).json({ error: 'Could not record this view' });
  }

  res.writeHead(upstream.status, heldMediaHeaders(contentType, upstream.headers));
  const deadline = setTimeout(() => abort.abort(), RETRACTED_MEDIA_STREAM_MS);
  await pipeline(Readable.fromWeb(upstream.body as NodeReadableStream), res)
    .catch((e) => {
      if (!abort.signal.aborted) console.error('[retracted-media] stream failed', e);
    })
    .finally(() => clearTimeout(deadline));
}

/** `noStore`: every answer, refusals included, so no shared cache keeps one. */
export default ModEndpoint(handler, ['GET'], { noStore: true });
