import { studioDatasetRatingSchema } from '~/server/schema/training-studio-dataset-rating.schema';
import { rateStudioDatasetImages } from '~/server/services/training-studio-dataset-rating.service';
import { AuthedEndpoint, handleEndpointError } from '~/server/utils/endpoint-helpers';
import { allowTrainingStudio } from '~/server/utils/training-studio-access';

export const config = { api: { bodyParser: { sizeLimit: '16kb' } } };

/**
 * The Training Studio's v2 dataset rating on the system-paid path, called by the Studio's server as
 * the session's user for both of its surfaces. POST { items: [{ mediaUrl, key }] } →
 * { results: [{ key, output }] }, `output` being the imageScanning step's, or null.
 */
export default AuthedEndpoint(
  async (req, res, user) => {
    if (!(await allowTrainingStudio(req, res, user, { pageFlag: false }))) return;
    res.setHeader('Cache-Control', 'no-store');
    const input = studioDatasetRatingSchema.safeParse(req.body);
    if (!input.success) return res.status(400).json({ error: 'Invalid dataset rating request.' });
    try {
      return res.json(await rateStudioDatasetImages({ ...input.data, userId: user.id }));
    } catch (e) {
      return handleEndpointError(res, e);
    }
  },
  ['POST']
);
