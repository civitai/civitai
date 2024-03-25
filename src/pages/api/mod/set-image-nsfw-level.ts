import { updateImageNsfwLevelSchema } from '~/server/schema/image.schema';
import { updateImageNsfwLevel } from '~/server/services/image.service';
import { ModEndpoint } from '~/server/utils/endpoint-helpers';

export default ModEndpoint(
  async (req, res, user) => {
    const { nsfwLevel, id } = updateImageNsfwLevelSchema.parse(req.query);

    await updateImageNsfwLevel({ id, nsfwLevel, user });

    return res.status(200).json({ status: 'ok' });
  },
  ['POST']
);
