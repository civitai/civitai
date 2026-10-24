import type { NextApiRequest, NextApiResponse } from 'next';
import * as z from 'zod';
import type { BareNotification } from '~/server/notifications/base.notifications';
import { populateNotificationDetails } from '~/server/notifications/detail-fetchers';
import {
  getNotificationMessage,
  notificationProcessors,
} from '~/server/notifications/utils.notifications';
import { WebhookEndpoint } from '~/server/utils/endpoint-helpers';

// Called by the apps/notifications push dispatcher, once per fanned-out notification row. The
// processor registry (prepareMessage) and the read-time detail enrichment both live only in this
// app, so push title/body/url can't be rendered inside the worker.
const schema = z.object({
  notifications: z
    .array(z.object({ type: z.string(), details: z.record(z.string(), z.any()) }))
    .max(100),
});

export default WebhookEndpoint(async (req: NextApiRequest, res: NextApiResponse) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues });

  const bare: BareNotification[] = parsed.data.notifications.map((n, i) => ({
    id: i,
    type: n.type,
    details: n.details,
  }));
  await populateNotificationDetails(bare);

  const results = bare.map((n) => {
    const prepared = getNotificationMessage(n);
    if (!prepared?.message) return null;
    return {
      title: notificationProcessors[n.type]?.displayName ?? 'Civitai',
      body: prepared.message,
      url: prepared.url ?? null,
    };
  });

  return res.status(200).json({ results });
});
