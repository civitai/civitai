import { setImageNsfwLevelSchema } from '~/server/schema/image.schema';
import { setImageNsfwLevel } from '~/server/services/image.service';
import { ModEndpoint } from '~/server/utils/endpoint-helpers';

export default ModEndpoint(
  async (req, res, user) => {
    const { nsfwLevel, id } = setImageNsfwLevelSchema.parse(req.query);

    await setImageNsfwLevel({ id, nsfwLevel, user });

    return res.status(200).json({ status: 'ok' });
  },
  ['POST']
);
