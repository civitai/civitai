import type { NextApiRequest, NextApiResponse } from 'next';
import * as z from 'zod';
import { isProbeableMediaKey } from '@civitai/shared/media-key';
import { RETRACTED_MEDIA_MAX_BYTES, RETRACTED_MEDIA_STREAM_MS } from '@civitai/shared/retracted-media';
import type { RetractedMedia } from '~/server/services/retracted-media.service';
import { streamStoredMedia } from '~/server/utils/stream-stored-media';

const query = z.object({ imageId: z.coerce.number().int().positive().max(2_147_483_647) });

export type OwnRetractedMediaDeps = {
  /** The `ownerBlockedMedia` flag for this viewer. */
  enabled: () => Promise<boolean>;
  /** Whether this viewer is under the route's rate limit, and if not, for how long. */
  rateLimit: () => Promise<{ allowed: boolean; retryAfterSeconds?: number }>;
  /** `getOwnRetractedMedia` for this viewer. */
  readMedia: (imageId: number) => Promise<Omit<RetractedMedia, 'held'> | null>;
};

/**
 * `/api/retracted-media/own/[imageId]`: the signed-in owner's own blocked image or video, from
 * storage, since the public CDN stops serving a blocked image's url. The browser names an image id;
 * the key comes from the row, only for an image `readMedia` leaves this owner, and the bytes come
 * through this server, so the storage URL never leaves it. A refusal answers as a missing image.
 */
export async function serveOwnRetractedMedia(
  req: NextApiRequest,
  res: NextApiResponse,
  { enabled, rateLimit, readMedia }: OwnRetractedMediaDeps
) {
  res.setHeader('cache-control', 'private, no-store');
  if (!(await enabled())) return void res.status(404).json({ error: 'Not available here' });

  const parsed = query.safeParse(req.query);
  if (!parsed.success) return void res.status(400).json({ error: 'Bad image id' });
  const { imageId } = parsed.data;

  const limit = await rateLimit();
  if (!limit.allowed) {
    res.setHeader('retry-after', String(limit.retryAfterSeconds ?? 60));
    return void res.status(429).json({ error: 'Too many requests' });
  }

  const media = await readMedia(imageId).catch(() => 'failed' as const);
  if (media === 'failed')
    return void res.status(503).json({ error: 'Could not check this image; retry' });
  if (!media || !isProbeableMediaKey(media.url))
    return void res.status(404).json({ error: 'Not available here' });
  if (req.query.probe === '1') return void res.status(204).end();

  await streamStoredMedia(req, res, {
    label: 'own-retracted-media',
    media,
    // The owner's own upload: nothing to audit.
    audit: async () => undefined,
    maxBytes: RETRACTED_MEDIA_MAX_BYTES,
    streamMs: RETRACTED_MEDIA_STREAM_MS,
  });
}
