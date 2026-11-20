import type { NextApiRequest, NextApiResponse } from 'next';
import * as z from 'zod';
import { prefixCacheKey } from '@civitai/redis';
import { isProbeableMediaKey } from '@civitai/shared/media-key';
import {
  RETRACTED_MEDIA_MAX_BYTES,
  RETRACTED_MEDIA_RATE_LIMIT,
  RETRACTED_MEDIA_STREAM_MS,
  RETRACTED_SERVED_ACTIVITY,
  retractedMediaRateKey,
} from '@civitai/shared/retracted-media';
import { getFeatureFlagsAsync } from '~/server/services/feature-flags.service';
import { trackModActivity } from '~/server/services/moderator.service';
import { getRetractedMedia } from '~/server/services/retracted-media.service';
import { ModEndpoint } from '~/server/utils/endpoint-helpers';
import { checkFixedWindow } from '~/server/utils/public-api-rate-limit';
import { streamStoredMedia } from '~/server/utils/stream-stored-media';
import type { SessionUser } from '~/types/session';

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
    prefixCacheKey(retractedMediaRateKey(user.id)),
    RETRACTED_MEDIA_RATE_LIMIT,
    60,
    { failOpen: false }
  );
  if (!limit.allowed) {
    res.setHeader('retry-after', String(limit.retryAfterSeconds));
    return void res.status(429).json({ error: 'Too many requests' });
  }

  // A read that fails or runs past its timeout refuses, with nothing served.
  const media = await getRetractedMedia(imageId, { csamReview: !!flags.csamReports }).catch(
    () => 'failed' as const
  );
  if (media === 'failed')
    return void res.status(503).json({ error: 'Could not check this image; retry' });
  if (!media) return void res.status(404).json({ error: 'Not available here' });
  if (!isProbeableMediaKey(media.url))
    return void res.status(422).json({ error: 'This file is not in a servable place' });
  // Eligibility alone, so a tile whose load failed can say why; nothing is served or audited.
  if (req.query.probe === '1') return void res.status(204).end();

  // Every response that carries bytes, ranges included, gets its row: unlike held-media, a range is
  // not assumed to belong to a view already recorded.
  await streamStoredMedia(req, res, {
    label: 'retracted-media',
    media,
    audit: () =>
      trackModActivity(user.id, {
        entityType: 'image',
        entityId: imageId,
        activity: RETRACTED_SERVED_ACTIVITY,
      }),
    auditEveryRange: true,
    maxBytes: RETRACTED_MEDIA_MAX_BYTES,
    streamMs: RETRACTED_MEDIA_STREAM_MS,
  });
}

/** `noStore`: every answer, refusals included, so no shared cache keeps one. */
export default ModEndpoint(handler, ['GET'], { noStore: true });
