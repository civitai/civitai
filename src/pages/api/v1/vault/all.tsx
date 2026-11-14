import { TRPCError } from '@trpc/server';
import type { NextApiRequest, NextApiResponse } from 'next';
import type { SessionUser } from '~/types/session';
import { getPaginatedVaultItems } from '~/server/services/vault.service';
import { AuthedEndpoint, handleEndpointError } from '~/server/utils/endpoint-helpers';
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

      // civitai#3845 (population B): the whole error OBJECT used to be
      // serialized here. The MEMBERSHIP_REQUIRED arm above is route-specific (it
      // answers 200), so it stays; everything else delegates.
      handleEndpointError(res, error);
      return;
    }
  },
  ['GET']
);
