import type { NextApiRequest, NextApiResponse } from 'next';
import * as z from 'zod';
import { sendNotificationEmails } from '~/server/services/notification-email.service';
import { WebhookEndpoint } from '~/server/utils/endpoint-helpers';

// Called by the apps/notifications fan-out worker, once per fanned-out notification of an email
// type, with the users it was newly delivered to.
const schema = z.object({
  type: z.string(),
  details: z.record(z.string(), z.any()),
  userIds: z.number().int().positive().array().max(1000),
});

export default WebhookEndpoint(async (req: NextApiRequest, res: NextApiResponse) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues });

  const outcome = await sendNotificationEmails(parsed.data);
  return res.status(200).json(outcome);
});
