import { NextApiRequest, NextApiResponse } from 'next';
import { resetManualAssignments } from '~/server/events/base.event';
import { WebhookEndpoint } from '~/server/utils/endpoint-helpers';

export default WebhookEndpoint(async function (req: NextApiRequest, res: NextApiResponse) {
  await resetManualAssignments(req.query.event as string);

  return res.status(200).json({
    ok: true,
  });
});
