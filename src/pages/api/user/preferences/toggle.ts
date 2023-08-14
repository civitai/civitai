import { toggleHiddenEntitySchema } from '~/server/schema/user-preferences.schema';
import {
  toggleHideModel,
  toggleHideUser,
  toggleHideImage,
} from '~/server/services/user-preferences.service';
import { AuthedEndpoint } from '~/server/utils/endpoint-helpers';

export default AuthedEndpoint(
  async function handler(req, res, user) {
    const { entityId, entityType } = toggleHiddenEntitySchema.parse(JSON.parse(req.body));
    const userId = user.id;
    try {
      switch (entityType) {
        case 'image':
          await toggleHideImage({ userId, imageId: entityId });
          break;
        case 'model':
          await toggleHideModel({ userId, modelId: entityId });
          break;
        case 'user':
          await toggleHideUser({ userId, targetUserId: entityId });
          break;
      }
      res.end();
    } catch (error: any) {
      res.status(500).json({
        message: `failed to toggle hidden entity: ${entityType} with id: ${entityId}`,
        error,
      });
    }
  },
  ['POST']
);
