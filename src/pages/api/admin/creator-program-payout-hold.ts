import type { AxiomAPIRequest } from '@civitai/next-axiom';
import { TRPCError } from '@trpc/server';
import type { NextApiResponse } from 'next';
import {
  openPayoutHold,
  openPayoutHoldSchema,
} from '~/server/services/creator-program-prepayout-review/hold';
import { handleEndpointError, ModEndpoint } from '~/server/utils/endpoint-helpers';

export default ModEndpoint(
  async function (req: AxiomAPIRequest, res: NextApiResponse, user) {
    try {
      const parsed = openPayoutHoldSchema.safeParse(req.body);
      if (!parsed.success)
        throw new TRPCError({ code: 'BAD_REQUEST', message: parsed.error.message });
      res.status(200).json(await openPayoutHold(parsed.data, `user:${user.id}`));
    } catch (e) {
      handleEndpointError(res, e);
    }
  },
  ['POST']
);
