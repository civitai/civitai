import type { NextApiRequest, NextApiResponse } from 'next';
import * as z from 'zod';
import { syncFreshdeskMembership } from '~/server/services/subscriptions.service';
import { WebhookEndpoint } from '~/server/utils/endpoint-helpers';

const schema = z.object({
  userId: z.coerce.number(),
});

export default WebhookEndpoint(async function handler(req: NextApiRequest, res: NextApiResponse) {
  const result = schema.safeParse(req.query);
  if (!result.success) return res.status(400).json(result.error);

  try {
    const data = await syncFreshdeskMembership(result.data);
    return res.status(200).json(data);
  } catch (error) {
    return res.status(500).json({ error: (error as Error).message });
  }
});
