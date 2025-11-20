import type { NextApiRequest, NextApiResponse } from 'next';
import * as z from 'zod';
import { ModEndpoint } from '~/server/utils/endpoint-helpers';
import { numericString } from '~/utils/zod-helpers';
import { setVaultFromSubscription } from '~/server/services/vault.service';
import { refreshSession } from '~/server/auth/session-invalidation';

const schema = z.object({
  userId: numericString(),
});

export default ModEndpoint(async (req: NextApiRequest, res: NextApiResponse) => {
  try {
    const data = schema.safeParse(req.query);

    if (!data.success) {
      return res.status(400).json({
        error: 'Invalid request body. Please provide a userId.',
        message:
          'This action will balance things out to return the bank to a 0 value. Do not use this lightly as many users could be left in limbo.',
      });
    }

    const { userId } = data.data;

    await setVaultFromSubscription({
      userId,
    });

    await refreshSession(userId);

    return res.status(200).json({
      message: 'Vault updated successfully.',
    });
  } catch (error) {
    console.log(error);
    return res.status(500).json({
      error: 'An error occurred while updating Vault.',
    });
  }
});
