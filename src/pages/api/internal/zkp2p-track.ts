import type { NextApiRequest, NextApiResponse } from 'next';
import { z } from 'zod';
import { Tracker } from '~/server/clickhouse/client';

const schema = z.object({
  sessionId: z.string(),
  eventType: z.enum(['attempt', 'success', 'error', 'abandoned']),
  paymentMethod: z.enum(['venmo', 'cashapp', 'paypal', 'zelle', 'wise', 'revolut']),
  usdAmount: z.number(),
  buzzAmount: z.number(),
  errorMessage: z.string().optional(),
});

export default async function zkp2pTrack(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });

  try {
    const data = schema.parse(req.body);
    const tracker = new Tracker(req, res);
    await tracker.zkp2pPayment(data);

    return res.status(200).json({ success: true });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: 'Invalid data', details: error.issues });
    }
    return res.status(500).json({ error: 'Internal server error' });
  }
}
