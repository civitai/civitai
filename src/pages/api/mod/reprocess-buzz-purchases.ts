import { NextApiRequest, NextApiResponse } from 'next';
import { getPaymentIntentsForBuzz } from '~/server/services/stripe.service';
import { WebhookEndpoint } from '~/server/utils/endpoint-helpers';
import { getPaymentIntentsForBuzzSchema } from '~/server/schema/stripe.schema';

export default WebhookEndpoint(async (req: NextApiRequest, res: NextApiResponse) => {
  const results = getPaymentIntentsForBuzzSchema.safeParse(req.query);
  if (!results.success) {
    return res.status(400).json({ ok: false, error: results.error.flatten().fieldErrors });
  }

  try {
    const payments = await getPaymentIntentsForBuzz(results.data);

    return res.status(200).json({ ok: true, processed: payments.length });
  } catch (error: any) {
    return res.status(500).json({ ok: false, error: error.message });
  }
});
