import { toggleHiddenTagsSchema } from '~/server/schema/user-preferences.schema';
import { toggleHiddenTags } from '~/server/services/user-preferences.service';
import { AuthedEndpoint } from '~/server/utils/endpoint-helpers';

export default AuthedEndpoint(
  async function handler(req, res, user) {
    try {
      const data = toggleHiddenTagsSchema.parse(JSON.parse(req.body));
      const result = await toggleHiddenTags({ ...data, userId: user.id });
      res.status(200).json(result);
    } catch (error: any) {
      res.status(500).json(error);
    }
  },
  ['POST']
);
