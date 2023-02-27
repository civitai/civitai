import { NextApiRequest, NextApiResponse } from 'next';
import { dbWrite } from '~/server/db/client';
import { z } from 'zod';
import { processImport } from '~/server/importers/importRouter';
import { ModEndpoint } from '~/server/utils/endpoint-helpers';

const importSchema = z.object({
  source: z.string().trim().url(),
  wait: z
    .preprocess((x) => x == 'true', z.boolean())
    .optional()
    .default(false),
  data: z.any().optional(),
});

export default ModEndpoint(
  async function importSource(req: NextApiRequest, res: NextApiResponse) {
    const { source, wait, data } = importSchema.parse(req.query);
    const userId = -1; //Default civitai user id

    const { id } = await dbWrite.import.create({
      data: {
        source,
        userId,
        data: data,
      },
      select: { id: true },
    });

    if (wait) {
      const result = await processImport({ id, source, userId, data });
      res.status(200).json(result);
    } else {
      res.status(200).json({ id });
      await processImport({ id, source, userId, data });
    }
  },
  ['GET']
);
