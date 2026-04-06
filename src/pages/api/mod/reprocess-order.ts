import type { NextApiRequest, NextApiResponse } from 'next';
import * as z from 'zod';
import coinbaseCaller from '~/server/http/coinbase/coinbase.caller';
import { reprocessDeposit } from '~/server/services/nowpayments.service';
import { processBuzzOrder as processBuzzOrderCoinbase } from '~/server/services/coinbase.service';
import { logToAxiom } from '~/server/logging/client';
import { ModEndpoint } from '~/server/utils/endpoint-helpers';

const schema = z.object({
  provider: z.enum(['nowpayments', 'coinbase']),
  orderId: z.string(),
});

export default ModEndpoint(
  async (req: NextApiRequest, res: NextApiResponse) => {
    const { provider, orderId } = schema.parse(req.query);

    if (!provider || !orderId) {
      return res.status(400).json({
        error: 'provider or orderId not provided. Please provide both.',
      });
    }

    try {
      if (provider === 'nowpayments') {
        const data = await reprocessDeposit(Number(orderId));
        if (!data) {
          return res.status(404).json({
            error: 'Order not found or not processed yet',
          });
        }

        logToAxiom({
          type: 'info',
          name: 'reprocess-order',
          message: 'Successfully reprocessed nowpayments order',
          provider,
          orderId,
        });
        return res.status(200).json(data);
      }

      if (provider === 'coinbase') {
        const orderDetails = await coinbaseCaller.getCharge(orderId);
        if (!orderDetails) {
          return res.status(404).json({
            error: 'Order not found or not processed yet',
          });
        }

        const reprocess = await processBuzzOrderCoinbase(orderDetails);

        logToAxiom({
          type: 'info',
          name: 'reprocess-order',
          message: 'Successfully reprocessed coinbase order',
          provider,
          orderId,
        });
        return res.status(200).json(reprocess);
      }
    } catch (e) {
      const error = e as Error;
      logToAxiom({
        type: 'error',
        name: 'reprocess-order',
        message: error.message,
        stack: error.stack,
        provider,
        orderId,
      });
      return res.status(500).json({
        error: error.message,
      });
    }
  },
  ['GET']
);
