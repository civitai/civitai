import type { NextApiRequest, NextApiResponse } from 'next';
import { bareNotification } from '~/server/notifications/base.notifications';
import { populateNotificationDetails } from '~/server/notifications/detail-fetchers';
import { AuthedEndpoint, handleEndpointError } from '~/server/utils/endpoint-helpers';

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
      // civitai#3845 (population B): `populateNotificationDetails` fans out over
      // per-type detail fetchers that query the DB directly, so the whole error
      // OBJECT serialized here was driver-derived.
      return handleEndpointError(res, error);
    }
  },
  ['POST']
);
