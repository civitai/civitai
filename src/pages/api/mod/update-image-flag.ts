import type { NextApiRequest, NextApiResponse } from 'next';
import { z } from 'zod';
import { updateImagesFlag } from '~/server/services/image.service';
import { ModEndpoint } from '~/server/utils/endpoint-helpers';
import { booleanString } from '~/utils/zod-helpers';

const stringToNumberArraySchema = z.string().transform((s) => s.split(',').map(Number));

const schema = z.object({
  ids: stringToNumberArraySchema,
  flag: z.enum(['poi', 'minor']),
  value: booleanString(),
});

export default ModEndpoint(
  async function updateImageFlag(req: NextApiRequest, res: NextApiResponse) {
    try {
      const { flag, ids, value } = schema.parse(req.query);
      await updateImagesFlag({ ids, flag, value });
      res.status(200).json({
        message: `Updated ${ids.length} images with flag ${flag} to ${value}`,
      });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ error: 'Internal server error' });
    }
  },
  ['GET']
);
