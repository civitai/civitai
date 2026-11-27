import type { NextApiRequest, NextApiResponse } from 'next';
import { prefixCacheKey } from '@civitai/redis';
import {
  RETRACTED_MEDIA_RATE_LIMIT,
  retractedMediaOwnRateKey,
} from '@civitai/shared/retracted-media';
import { getFeatureFlagsAsync } from '~/server/services/feature-flags.service';
import { getHeldLevelsByPost } from '~/server/services/model.service';
import { getOwnRetractedMedia } from '~/server/services/retracted-media.service';
import { AuthedEndpoint } from '~/server/utils/endpoint-helpers';
import {
  ownRetractedMediaViewer,
  serveOwnRetractedMedia,
} from '~/server/utils/own-retracted-media';
import { checkFixedWindow } from '~/server/utils/public-api-rate-limit';
import { shownReviewImageLevelsFor } from '~/server/utils/review-image-levels';
import type { Session, SessionUser } from '~/types/session';

export const config = { api: { responseLimit: false } };

const endpoint = AuthedEndpoint(
  (req: NextApiRequest, res: NextApiResponse, user: SessionUser, session: Session) => {
    const features = getFeatureFlagsAsync({ user, req });
    return serveOwnRetractedMedia(req, res, {
      viewer: ownRetractedMediaViewer(req, user, session),
      enabled: async () => !!(await features).ownerBlockedMedia,
      rateLimit: () =>
        checkFixedWindow(
          prefixCacheKey(retractedMediaOwnRateKey(user.id)),
          RETRACTED_MEDIA_RATE_LIMIT,
          60,
          { failOpen: false }
        ),
      // The image page's own opt-in levels, so a review image opens here as it does there.
      readMedia: async (imageId) =>
        getOwnRetractedMedia(imageId, user.id, {
          shownReviewImageLevels: shownReviewImageLevelsFor({
            features: await features,
            user,
            req,
          }),
        }),
      heldFor: async (postId) => (await getHeldLevelsByPost([postId])).get(postId),
    });
  },
  ['GET']
);

/** `private, no-store` on every answer, the wrapper's own refusals included. */
export default function ownRetractedMedia(req: NextApiRequest, res: NextApiResponse) {
  res.setHeader('cache-control', 'private, no-store');
  return endpoint(req as Parameters<typeof endpoint>[0], res);
}
