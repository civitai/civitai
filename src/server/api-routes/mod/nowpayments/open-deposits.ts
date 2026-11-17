import type { NextApiRequest, NextApiResponse } from 'next';
import { getOpenDepositReport } from '~/server/services/nowpayments.service';
import { ModEndpoint } from '~/server/utils/endpoint-helpers';

// Read-only: support polls this for its deposit health check, so it must never trigger work.
export default ModEndpoint(
  async (_req: NextApiRequest, res: NextApiResponse) => {
    const { items, counts } = await getOpenDepositReport();
    return res.status(200).json({
      counts,
      deposits: items.map((i) => ({
        paymentId: i.paymentId,
        userId: i.userId,
        coin: i.payCurrency,
        actuallyPaid: i.payAmount,
        npStatus: i.status,
        daysOpen: i.daysOpen,
        heldForReview: i.held,
      })),
    });
  },
  ['GET']
);
