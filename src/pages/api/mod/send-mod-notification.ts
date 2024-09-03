import {
  createNotification,
  createNotificationPendingRow,
} from '~/server/services/notification.service';
import { WebhookEndpoint } from '~/server/utils/endpoint-helpers';

export default WebhookEndpoint(async (req, res) => {
  if (req.method !== 'POST') return res.status(405).send('Method Not Allowed');

  try {
    const result = createNotificationPendingRow.safeParse(req.body);
    if (!result.success) return res.status(400).send(result.error.message);

    await createNotification(result.data);

    return res.status(200).json({ status: 'ok' });
  } catch (error: unknown) {
    res.status(500).send(error);
  }
});
