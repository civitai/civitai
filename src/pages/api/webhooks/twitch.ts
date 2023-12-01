import { NextApiRequest, NextApiResponse } from 'next';
import { WebhookEndpoint } from '~/server/utils/endpoint-helpers';
import { setLiveNow } from '~/server/services/system-cache';

// Notification request headers
const TWITCH_MESSAGE_TYPE = 'Twitch-Eventsub-Message-Type'.toLowerCase();

export default WebhookEndpoint(async (req: NextApiRequest, res: NextApiResponse) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const notificationType = req.headers[TWITCH_MESSAGE_TYPE] as string;
  if (notificationType === 'webhook_callback_verification')
    return res.status(200).send(req.body.challenge);
  if (notificationType !== 'notification') return res.status(200).json({ success: true });

  const { subscription } = req.body;

  await setLiveNow(subscription.type === 'stream.online');
  return res.status(200).json({ success: true });
});
