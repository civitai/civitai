import type { NextApiRequest, NextApiResponse } from 'next';
import { z } from 'zod';
import coinbaseCaller from '~/server/http/coinbase/coinbase.caller';
import { clavata } from '~/server/integrations/clavata';
import { processBuzzOrder as processBuzzOrderNowPayments } from '~/server/services/nowpayments.service';
import { processBuzzOrder as processBuzzOrderCoinbase } from '~/server/services/coinbase.service';
import { ModEndpoint } from '~/server/utils/endpoint-helpers';

const schema = z.object({
  provider: z.enum(['nowpayments', 'coinbase']),
  orderId: z.string(),
});

export default ModEndpoint(
  async (req: NextApiRequest, res: NextApiResponse) => {
    const { provider, orderId } = schema.parse(req.body);

    if (!provider || !orderId) {
      return res.status(400).json({
        error: 'provider or orderId not provided. Please provide both.',
      });
    }

    try {
      if (provider === 'nowpayments') {
        const data = await processBuzzOrderNowPayments(orderId);
        if (!data) {
          return res.status(404).json({
            error: 'Order not found or not processed yet',
          });
        }

        return res.status(200).json(data);
      }

      if (provider === 'coinbase') {
        // Assuming you have a function to process Coinbase orders
        const orderDetails = await coinbaseCaller.getCharge(orderId);
        if (!orderDetails) {
          return res.status(404).json({
            error: 'Order not found or not processed yet',
          });
        }

        const reprocess = await processBuzzOrderCoinbase(orderDetails);

        return res.status(200).json(reprocess);
      }
    } catch (e) {
      console.error('Error processing image with Clavata:', e);
      return res.status(500).json({
        error: (e as Error).message,
      });
    }
  },
  ['GET']
);
