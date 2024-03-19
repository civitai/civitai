import { NextApiRequest, NextApiResponse } from 'next';
import { SessionUser } from 'next-auth';
import { z } from 'zod';
import { dbRead } from '~/server/db/client';
import { AuthedEndpoint } from '~/server/utils/endpoint-helpers';
import { commaDelimitedNumberArray } from '~/utils/zod-helpers';

const schema = z.object({
  modelVersionIds: commaDelimitedNumberArray(),
});

export default AuthedEndpoint(
  async function handler(req: NextApiRequest, res: NextApiResponse, user: SessionUser) {
    const results = schema.safeParse(req.query);
    if (!results.success)
      return res.status(400).json({ error: `Could not parse provided model versions array.` });

    const modelVersionIds = results.data.modelVersionIds;

    if (modelVersionIds.length === 0) {
      return res.status(200).json([]);
    }

    try {
      const vaultItems = await dbRead.vaultItem.findMany({
        where: {
          vaultId: user.id,
          modelVersionId: {
            in: results.data.modelVersionIds,
          },
        },
      });
      return res.json(
        modelVersionIds.map((v) => ({
          modelVersionId: v,
          vaultItem: vaultItems.find((vi) => vi.modelVersionId === v) ?? null,
        }))
      );
    } catch (error) {
      return res.status(500).json({ message: 'An unexpected error occurred', error });
    }
  },
  ['GET']
);
