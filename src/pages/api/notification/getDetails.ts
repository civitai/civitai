import type { NextApiRequest, NextApiResponse } from 'next';
import { bareNotification } from '~/server/notifications/base.notifications';
import { populateNotificationDetails } from '~/server/notifications/detail-fetchers';
import { AuthedEndpoint } from '~/server/utils/endpoint-helpers';

const schema = bareNotification;

export default AuthedEndpoint(
  async function handler(req: NextApiRequest, res: NextApiResponse) {
    const results = schema.safeParse(req.body);
    if (!results.success) {
      return res.status(400).json({ error: `Could not parse notification data` });
    }

    try {
      await populateNotificationDetails([results.data]);
      return res.json(results.data);
    } catch (error) {
      return res.status(500).json({ message: 'An unexpected error occurred', error });
    }
  },
  ['POST']
);
