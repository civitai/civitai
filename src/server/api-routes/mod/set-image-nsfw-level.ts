import { updateImageNsfwLevelSchema } from '~/server/schema/image.schema';
import { updateImageNsfwLevel } from '~/server/services/image.service';
import { getFeatureFlags } from '~/server/services/feature-flags.service';
import { handleEndpointError, ModEndpoint } from '~/server/utils/endpoint-helpers';

export default ModEndpoint(
  async (req, res, user) => {
    const { nsfwLevel, id } = updateImageNsfwLevelSchema.parse(req.query);

    try {
      await updateImageNsfwLevel({
        id,
        nsfwLevel,
        userId: user.id,
        isModerator: user.isModerator,
        csamReview: !!getFeatureFlags({ user, req }).csamReports,
      });
    } catch (e) {
      return handleEndpointError(res, e);
    }

    return res.status(200).json({ status: 'ok' });
  },
  ['POST']
);
