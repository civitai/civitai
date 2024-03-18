import { TRPCError } from '@trpc/server';
import { NextApiRequest, NextApiResponse } from 'next';
import { SessionUser } from 'next-auth';
import { getOrCreateVault } from '~/server/services/vault.service';
import { AuthedEndpoint } from '~/server/utils/endpoint-helpers';

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

      res.status(500).json({ message: 'An unexpected error occurred', error });
    }
  },
  ['GET']
);
