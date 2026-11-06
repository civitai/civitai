/**
 * eMerchantPay is retired. Its notifications are refused and nothing is credited; the purchase
 * option is off (`emerchantpayPayments`).
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { instrumentApiResponse } from '~/server/prom/http-errors';

export const config = {
  api: {
    bodyParser: false,
  },
};

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  instrumentApiResponse(req, res);
  return res.status(410).send({ error: 'Gone' });
}
