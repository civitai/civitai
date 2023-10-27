import { z } from 'zod';
import { getIngestionResults } from '~/server/services/image.service';
import { AuthedEndpoint } from '~/server/utils/endpoint-helpers';
import { commaDelimitedNumberArray } from '~/utils/zod-helpers';

const schema = z.object({
  ids: commaDelimitedNumberArray(),
});

export default AuthedEndpoint(
  async function handler(req, res, user) {
    const { ids } = schema.parse(req.query);
    const data = await getIngestionResults({ ids, userId: user.id });
    res.status(200).json(data);
  },
  ['GET']
);
