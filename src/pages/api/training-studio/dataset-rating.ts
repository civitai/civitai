import { studioDatasetRatingSchema } from '~/server/schema/training-studio-dataset-rating.schema';
import {
  rateStudioDatasetImages,
  STUDIO_DATASET_RATING_RATE_LIMIT,
} from '~/server/services/training-studio-dataset-rating.service';
import { AuthedEndpoint, handleEndpointError } from '~/server/utils/endpoint-helpers';
import { claimRateLimitAttempt } from '~/server/utils/rate-limit-bucket';
import { allowTrainingStudio } from '~/server/utils/training-studio-access';

export const config = { api: { bodyParser: { sizeLimit: '16kb' } } };

// Both Studio surfaces reach this through the Studio's server, so it is gated like check-text, not
// as standalone-only.
export default AuthedEndpoint(
  async (req, res, user) => {
    if (!(await allowTrainingStudio(req, res, user, { pageFlag: false }))) return;
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
      return res.json(await rateStudioDatasetImages({ ...input.data, userId: user.id }));
    } catch (e) {
      return handleEndpointError(res, e);
    }
  },
  ['POST']
);
