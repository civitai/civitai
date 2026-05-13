import * as z from 'zod';
import { getIngestionResults } from '~/server/services/image.service';
import { AuthedEndpoint } from '~/server/utils/endpoint-helpers';
import { commaDelimitedNumberArray } from '~/utils/zod-helpers';

const schema = z.object({
  ids: commaDelimitedNumberArray(),
});

export default AuthedEndpoint(
  async function handler(req, res, user) {
    const result = schema.safeParse(req.query);
    if (!result.success) return res.status(400).json({ error: result.error });
    const { ids } = result.data;
    const data = await getIngestionResults({ ids, userId: user.id });
    res.status(200).json(data);
  },
  ['GET']
);
