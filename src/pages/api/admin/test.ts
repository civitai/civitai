import type { NextApiRequest, NextApiResponse } from 'next';
import { getConsumerStrikes } from '~/server/http/orchestrator/flagged-consumers';
import { WebhookEndpoint } from '~/server/utils/endpoint-helpers';
import { getServerAuthSession } from '~/server/utils/get-server-auth-session';

export default WebhookEndpoint(async function (req: NextApiRequest, res: NextApiResponse) {
  try {
    const session = await getServerAuthSession({ req, res });

    const data = await getConsumerStrikes({ consumerId: 'civitai-9629602' });
    res.status(200).send(data);
  } catch (e) {
    console.log(e);
    res.status(400).end();
  }
});
