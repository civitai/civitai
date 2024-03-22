import { TRPCError } from '@trpc/server';
import { NextApiRequest, NextApiResponse } from 'next';
import { SessionUser } from 'next-auth';
import { getPaginatedVaultItems } from '~/server/services/vault.service';
import { AuthedEndpoint } from '~/server/utils/endpoint-helpers';
import { getPaginatedVaultItemsSchema } from '~/server/schema/vault.schema';

export default AuthedEndpoint(
  async function handler(req: NextApiRequest, res: NextApiResponse, user: SessionUser) {
    try {
      const input = getPaginatedVaultItemsSchema.parse(req.query);
      const vaultItems = await getPaginatedVaultItems({ ...input, userId: user.id });
      res.json({
        ...vaultItems,
      });
    } catch (error) {
      const isTrpcError = error instanceof TRPCError;
      if (isTrpcError) {
        const trpcError = error as TRPCError;
        if (trpcError.cause?.message === 'MEMBERSHIP_REQUIRED') {
          res.status(200).json({ vault: null });
          return;
        }
      }

      res.status(500).json({ message: 'An unexpected error occurred', error });
    }
  },
  ['GET']
);
