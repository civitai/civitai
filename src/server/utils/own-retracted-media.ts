import type { NextApiRequest, NextApiResponse } from 'next';
import * as z from 'zod';
import { isProbeableMediaKey } from '@civitai/shared/media-key';
import {
  RETRACTED_MEDIA_MAX_BYTES,
  RETRACTED_MEDIA_STREAM_MS,
} from '@civitai/shared/retracted-media';
import type { OwnRetractedMedia } from '~/server/services/retracted-media.service';
import { isFullScopeSession } from '~/server/utils/require-full-scope-session';
import { streamStoredMedia } from '~/server/utils/stream-stored-media';
import { Flags } from '~/shared/utils/flags';

const query = z.object({ imageId: z.coerce.number().int().positive().max(2_147_483_647) });

export type OwnRetractedMediaDeps = {
  viewer: {
    id: number;
    /** A moderator acting as the owner. */
    impersonated: boolean;
    /** A browser session or a full-access key, not a scoped key or app token. */
    fullScope: boolean;
  };
  /** The `ownerBlockedMedia` flag for this viewer. */
  enabled: () => Promise<boolean>;
  /** Whether this viewer is under the route's rate limit, and if not, for how long. */
  rateLimit: () => Promise<{ allowed: boolean; retryAfterSeconds?: number }>;
  /** `getOwnRetractedMedia` for this viewer. */
  readMedia: (imageId: number) => Promise<OwnRetractedMedia | null>;
  /** `getHeldLevelsByPost` for one post: the level its model holds it to, and that model's owner. */
  heldFor: (postId: number) => Promise<{ level: number; ownerId?: number } | undefined>;
};

/** The route's `viewer`, from the signed-in user and the request that carried their sign-in. */
export const ownRetractedMediaViewer = (
  req: NextApiRequest,
  user: { id: number },
  session: { impersonatedBy?: unknown }
): OwnRetractedMediaDeps['viewer'] => ({
  id: user.id,
  impersonated: session.impersonatedBy != null,
  fullScope: isFullScopeSession(req),
});

/**
 * `/api/retracted-media/own/[imageId]`: the signed-in owner's own blocked image or video, from
 * storage, since the public CDN stops serving a blocked image's url. The browser names an image id;
 * the key comes from the row, only for an image `readMedia` leaves this owner, and the bytes come
 * through this server, so the storage URL never leaves it. A refusal answers as a missing image.
 * The page's other gate, `image.get`'s held level (`withoutHeldFromViewer`), applies here too.
 */
export async function serveOwnRetractedMedia(
  req: NextApiRequest,
  res: NextApiResponse,
  { viewer, enabled, rateLimit, readMedia, heldFor }: OwnRetractedMediaDeps
) {
  res.setHeader('cache-control', 'private, no-store');
  if (!(await enabled())) return void res.status(404).json({ error: 'Not available here' });
  if (viewer.impersonated || !viewer.fullScope)
    return void res.status(403).json({ error: 'Not available with this sign-in' });

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
  const hold = media.postId
    ? await heldFor(media.postId).catch(() => 'failed' as const)
    : undefined;
  if (hold === 'failed')
    return void res.status(503).json({ error: 'Could not check this image; retry' });
  if (hold && hold.ownerId !== viewer.id && !Flags.intersects(hold.level, media.nsfwLevel))
    return void res.status(404).json({ error: 'Not available here' });
  if (req.query.probe === '1') return void res.status(204).end();

  await streamStoredMedia(req, res, {
    label: 'own-retracted-media',
    media: { url: media.url, type: media.type, mimeType: media.mimeType },
    // The owner's own upload: nothing to audit.
    audit: async () => undefined,
    maxBytes: RETRACTED_MEDIA_MAX_BYTES,
    streamMs: RETRACTED_MEDIA_STREAM_MS,
  });
}
