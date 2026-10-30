import type { NextApiRequest, NextApiResponse } from 'next';
import type { SessionUser } from '~/types/session';
import * as z from 'zod';
import { toggleModelVersionOnVault } from '~/server/services/vault.service';
import { AuthedEndpoint, handleEndpointError } from '~/server/utils/endpoint-helpers';
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
          vaultId: result?.id,
        })
      );
    } catch (error) {
      // civitai#3845 (population B). This is the one WRITE among the vault
      // routes, so it is also the one that can raise a real unique-constraint
      // violation — the class whose driver payload carries actual row data.
      return handleEndpointError(res, error);
    }
  },
  ['POST']
);
