import { buildFliptContext } from '@civitai/flipt/context';
import { FLIPT_FEATURE_FLAGS, getFliptVariant } from '~/server/flipt/client';
import { studioDatasetRatingSchema } from '~/server/schema/training-studio-dataset-rating.schema';
import {
  rateStudioDatasetImages,
  STUDIO_DATASET_RATING_GLOBAL_LIMIT,
  STUDIO_DATASET_RATING_RATE_LIMIT,
} from '~/server/services/training-studio-dataset-rating.service';
import { AuthedEndpoint, handleEndpointError } from '~/server/utils/endpoint-helpers';
import { checkFixedWindow } from '~/server/utils/public-api-rate-limit';
import { claimRateLimitAttempt } from '~/server/utils/rate-limit-bucket';
import { allowTrainingStudio } from '~/server/utils/training-studio-access';
import type { SessionUser } from '~/types/session';

export const config = { api: { bodyParser: { sizeLimit: '16kb' } } };

// Both Studio surfaces reach this through the Studio's server, so it is gated like check-text, not
// as standalone-only.
export default AuthedEndpoint(
  async (req, res, user) => {
    if (!(await allowTrainingStudio(req, res, user, { pageFlag: false }))) return;
    // Off for this user: refused before any limit is counted or anything is submitted.
    if (!(await isDatasetRatingOn(user)))
      return res.status(403).json({ error: 'Dataset rating is not available on this account.' });
    res.setHeader('Cache-Control', 'no-store');
    const input = studioDatasetRatingSchema.safeParse(req.body);
    if (!input.success) return res.status(400).json({ error: 'Invalid dataset rating request.' });
    try {
      const record = await claimRateLimitAttempt({
        rules: STUDIO_DATASET_RATING_RATE_LIMIT.rules,
        keyName: STUDIO_DATASET_RATING_RATE_LIMIT.key,
        user,
        req,
      });
      await record();
      const { key, max, windowSeconds } = STUDIO_DATASET_RATING_GLOBAL_LIMIT;
      const global = await checkFixedWindow(key, max, windowSeconds, { failOpen: false });
      if (!global.allowed) {
        res.setHeader('Retry-After', String(global.retryAfterSeconds));
        return res.status(429).json({ error: 'Dataset rating is unavailable until tomorrow.' });
      }
      return res.json(await rateStudioDatasetImages({ ...input.data, userId: user.id }));
    } catch (e) {
      return handleEndpointError(res, e);
    }
  },
  ['POST']
);

/** The Studio's own reading of the flag (parseMatureLevel): only a variant s1-s4 is on. Flipt failing
 *  answers null, so it refuses. */
async function isDatasetRatingOn(user: SessionUser): Promise<boolean> {
  const variant = await getFliptVariant(
    FLIPT_FEATURE_FLAGS.TRAINING_STUDIO_DATASET_RATING_V2,
    String(user.id),
    buildFliptContext(user)
  ).catch(() => null);
  return typeof variant === 'string' && /^s[1-4]$/i.test(variant.trim());
}
