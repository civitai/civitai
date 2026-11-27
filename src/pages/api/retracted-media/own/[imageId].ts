import type { NextApiRequest, NextApiResponse } from 'next';
import { prefixCacheKey } from '@civitai/redis';
import { RETRACTED_MEDIA_RATE_LIMIT } from '@civitai/shared/retracted-media';
import { getFeatureFlagsAsync } from '~/server/services/feature-flags.service';
import { getHeldLevelsByPost } from '~/server/services/model.service';
import { getOwnRetractedMedia } from '~/server/services/retracted-media.service';
import { AuthedEndpoint } from '~/server/utils/endpoint-helpers';
import { serveOwnRetractedMedia } from '~/server/utils/own-retracted-media';
import { checkFixedWindow } from '~/server/utils/public-api-rate-limit';
import { isFullScopeSession } from '~/server/utils/require-full-scope-session';
import type { Session, SessionUser } from '~/types/session';

export const config = { api: { responseLimit: false } };

const endpoint = AuthedEndpoint(
  (req: NextApiRequest, res: NextApiResponse, user: SessionUser, session: Session) =>
    serveOwnRetractedMedia(req, res, {
      viewer: {
        id: user.id,
        impersonated: session.impersonatedBy != null,
        fullScope: isFullScopeSession(req),
      },
      enabled: async () => !!(await getFeatureFlagsAsync({ user, req })).ownerBlockedMedia,
      rateLimit: () =>
        checkFixedWindow(
          prefixCacheKey(`retracted-media:own:rate-limit:${user.id}`),
          RETRACTED_MEDIA_RATE_LIMIT,
          60,
          { failOpen: false }
        ),
      readMedia: (imageId) => getOwnRetractedMedia(imageId, user.id),
      heldFor: async (postId) => (await getHeldLevelsByPost([postId])).get(postId),
    }),
  ['GET']
);

/** `private, no-store` on every answer, the wrapper's own refusals included. */
export default function ownRetractedMedia(req: NextApiRequest, res: NextApiResponse) {
  res.setHeader('cache-control', 'private, no-store');
  return endpoint(req as Parameters<typeof endpoint>[0], res);
}
