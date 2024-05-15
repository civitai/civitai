import { NextApiRequest, NextApiResponse } from 'next';
import { SessionUser } from 'next-auth';
import { z } from 'zod';
import { toggleModelVersionOnVault } from '~/server/services/vault.service';
import { AuthedEndpoint } from '~/server/utils/endpoint-helpers';
import { removeEmpty } from '~/utils/object-helpers';

const schema = z.object({
  modelVersionId: z.coerce.number(),
});

export default AuthedEndpoint(
  async function handler(req: NextApiRequest, res: NextApiResponse, user: SessionUser) {
    const results = schema.safeParse(req.query);
    if (!results.success)
      return res.status(400).json({ error: `Could not parse provided model version` });

    try {
      const result = await toggleModelVersionOnVault({
        userId: user.id,
        modelVersionId: results.data.modelVersionId,
      });
      return res.json(
        removeEmpty({
          success: true,
          vaultId: result?.vaultId,
        })
      );
    } catch (error) {
      return res.status(500).json({ message: 'An unexpected error occurred', error });
    }
  },
  ['POST']
);
