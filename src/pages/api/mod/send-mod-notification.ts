import { notificationSingleRowFull } from '~/server/jobs/send-notifications';
import { createNotification } from '~/server/services/notification.service';
import { ModEndpoint } from '~/server/utils/endpoint-helpers';

export default ModEndpoint(
  async (req, res) => {
    try {
      const result = notificationSingleRowFull.safeParse(req.body);
      if (!result.success) return res.status(400).send(result.error.message);

      await createNotification(result.data);

      return res.status(200).json({ status: 'ok' });
    } catch (error: unknown) {
      res.status(500).send(error);
    }
  },
  ['POST']
);
