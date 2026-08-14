import { TRPCError } from '@trpc/server';
import type { NextApiRequest, NextApiResponse } from 'next';
import type { SessionUser } from '~/types/session';
import { getOrCreateVault } from '~/server/services/vault.service';
import { AuthedEndpoint, handleEndpointError } from '~/server/utils/endpoint-helpers';

export default AuthedEndpoint(
  async function handler(req: NextApiRequest, res: NextApiResponse, user: SessionUser) {
    try {
      const vault = await getOrCreateVault({ userId: user.id });
      res.json({
        vault,
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

      // civitai#3845 (population B) — see `v1/vault/all.tsx`. Same shape, same
      // MEMBERSHIP_REQUIRED arm kept, same delegation.
      handleEndpointError(res, error);
      return;
    }
  },
  ['GET']
);
